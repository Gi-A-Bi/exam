# Edge Functions 계약 명세 — OMR

확정된 인증 모델: **교사 = 이메일(Supabase Auth) 로그인 + 공개 `teacher_code`**.

이 결정으로 Edge Function이 필요한 건 **2개**뿐:
- `register_teacher` — joinCode를 노출하지 않고 검증해야 하므로 서버측 필요
- `submit_for_student` — 정답지 조회 + 채점 + 정답 비노출을 서버에서 보장해야 함

나머지는 Edge Function 불필요:
- **로그인** → 클라이언트가 `supabase.auth.signInWithPassword(email, password)` 직접 호출
- **교사 존재 확인** → RPC `get_teacher_public(code)`
- **학교 정보** → RPC `get_public_info()`
- **정답지 CRUD / 결과 조회·정정** → 교사는 로그인 상태이므로 `supabase-js`로 테이블 직접 접근(RLS가 본인 것만 허용). 단, 정정 시 점수는 §submissions 트리거가 재계산.

> 채점 로직은 공용 모듈 `grading.js`(기존 5개 함수 이식본)를 Edge Function이 그대로 임포트한다.
> Supabase 관례상 `supabase/functions/_shared/grading.js`에 두고 각 함수에서 import.
> **plpgsql 재구현 금지 (불변식 2-1).**

---

## 1. `register_teacher`

> **결정(2026-07): 학교 가입코드(joinCode) 폐지.** 요청에서 joinCode 를 받지 않고
> 검증도 하지 않는다 — 누구나 가입 가능. 아래 원문 명세의 joinCode 부분은 무효.
>
> **결정(2026-07-14): 교사별 학교명(school) 추가.** 가입코드 폐지로 여러 학교
> 교사가 섞일 수 있어, 가입 시 학교명을 받아 `teachers.school` 에 저장하고
> 학생 입장 화면에서 "○○학교 ○○ 선생님"으로 확인시킨다.
> 프론트는 필수 입력(2자 이상), 서버는 선택 처리(trim 후 40자 제한, 없으면 null
> — 마이그레이션 전 구버전 프론트 호환). `get_teacher_public` 이 school 을 반환.

### Request
```json
{
  "email":    "teacher@school.kr",
  "password": "비밀번호(6자 이상)",
  "name":     "김민성",
  "code":     "KIM01",
  "school":   "서울송정초등학교"
}
```

### 처리 순서
1. **joinCode 검증**: `settings`에서 `joinCode` 조회 후 일치 확인. 불일치 → 에러.
   (joinCode는 절대 클라이언트로 반환/노출하지 않음.)
2. **입력 검증**: 비밀번호 6자 이상, 이름 존재.
3. **코드 정규화·검증**: 대문자화 + `[A-Z0-9\-_]` 외 제거. 정규화 후 3자 이상.
4. **코드 중복 확인**: `teachers.code` 유니크. 중복 → 에러. *(auth 사용자 생성 전에 먼저 확인해 고아 계정 방지)*
5. **Auth 사용자 생성**: service_role로 `auth.admin.createUser({ email, password, email_confirm })`.
   - 이메일 중복 → 에러 메시지 반환.
6. **프로필 insert**: `teachers(id = 신규 user.id, code, name)`.
   - 이 단계 실패 시 5에서 만든 auth 사용자를 삭제(롤백)해 고아 계정 방지.
7. 성공 반환. 클라이언트는 이어서 `signInWithPassword`로 세션 획득.

### Response (성공)
```json
{ "ok": true, "data": { "code": "KIM01", "name": "김민성" } }
```
### Response (실패)
```json
{ "ok": false, "error": "가입코드가 일치하지 않습니다." }
```
에러 케이스: 가입코드 불일치 / 비밀번호 짧음 / 코드 형식·길이 / 코드 중복 / 이메일 이미 사용 중.

### 결정 필요 — 이메일 확인(email_confirm)
- **권장: `email_confirm: true`(가입 즉시 확정, 메일 인증 생략).**
  joinCode가 이미 1차 관문이라 메일 인증까지 요구하면 "메일 안 와요" 문의가 늘어남.
  비밀번호 재설정은 여전히 메일로 동작.
- 보안을 더 원하면 `email_confirm` 생략(사용자가 메일로 인증). — 확정해 주세요.

### 스켈레톤 (TS, Deno)
```ts
// supabase/functions/register_teacher/index.ts
import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,   // 서버 전용
);

const normalizeCode = (s: string) =>
  (s ?? "").trim().toUpperCase().replace(/[^A-Z0-9\-_]/g, "");

Deno.serve(async (req) => {
  try {
    const { email, password, name, code, joinCode } = await req.json();

    const { data: jc } = await admin.from("settings")
      .select("value").eq("key", "joinCode").maybeSingle();
    if (!joinCode || joinCode !== jc?.value)
      return json({ ok: false, error: "가입코드가 일치하지 않습니다." });

    if (!name || !email || !password)  return json({ ok:false, error:"필수 항목 누락" });
    if (password.length < 6)           return json({ ok:false, error:"비밀번호는 6자 이상" });

    const ncode = normalizeCode(code);
    if (ncode.length < 3)              return json({ ok:false, error:"코드는 3자 이상" });

    const { data: dup } = await admin.from("teachers")
      .select("code").eq("code", ncode).maybeSingle();
    if (dup)                           return json({ ok:false, error:"이미 사용 중인 코드" });

    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (cErr) return json({ ok:false, error: cErr.message });   // 이메일 중복 등

    const { error: pErr } = await admin.from("teachers")
      .insert({ id: created.user.id, code: ncode, name: name.trim() });
    if (pErr) {
      await admin.auth.admin.deleteUser(created.user.id);       // 롤백
      return json({ ok:false, error: pErr.message });
    }
    return json({ ok:true, data:{ code: ncode, name: name.trim() } });
  } catch (e) {
    return json({ ok:false, error: String((e as Error).message ?? e) });
  }
});

const json = (o: unknown) =>
  new Response(JSON.stringify(o), { headers: { "Content-Type":"application/json" } });
```

---

## 2. `submit_for_student`

> **v2 (반+PIN 도입, 확정)**: 학생은 [선생님 코드 → 반 선택 → 이름+PIN]으로 입장한다.
> - 입장/등록: RPC `student_enter(class_id, name, pin)` — 첫 입장이면 등록+PIN 설정(C안),
>   교사가 초기화한 상태면 새 PIN 설정, 그 외에는 PIN 검증.
> - PIN 분실: 교사가 반 관리에서 초기화(`students.pin_hash=null`) → 다음 입장 시 재설정.
> - 반 목록: RPC `list_classes_public(teacher_code)`. 시험 목록: RPC `list_exams_for_student(class_id)`.
> - 내 성적 보기: RPC `student_history(class_id, name, pin)` — PIN 재검증 후 본인 제출 기록만.
>   detail 은 q/type/multi/isCorrect(교사 정정 반영)/needsReview 만 반환(정답·입력값 비노출, 불변식 2-2).
> - 제출 불변성: 같은 학생(student_id)의 같은 시험 재제출은 거부(unique index).
>   교사가 해당 제출 행을 삭제하면 재제출 가능.

### Request (v2)
```json
{
  "examId": "uuid",
  "classId": "uuid",
  "name": "홍길동",
  "pin": "1234",
  "answers": [
    { "q": 1, "answer": 3 },
    { "q": 2, "answer": [1, 3] },
    { "q": 3, "answer": "정답텍스트" }
  ]
}
```
서버 처리: `student_verify(class_id, name, pin)` 로 PIN 재검증(불일치 → 거부) →
시험이 해당 교사 소유이고 반 배정(`class_id null=공통`)에 맞는지 확인 →
재제출 검사 → 채점(grading.js) → insert(student_id, class_id 포함) → 정답 제거 후 반환.

### 처리 순서
1. 입력 검증: teacherCode, examId, name 존재 + `answers`가 배열.
2. teacherCode 정규화 → `teachers`에서 조회해 `teacher_id` 확보. 없으면 에러.
3. `answer_keys`에서 `id = examId AND teacher_id` 조회(service_role, RLS 우회). 없으면 에러.
4. **채점**: `grading.js`의 `gradeSubmission_(exam, answers)` 호출 → `{count, correct, score, detail}`.
5. `submissions` insert: **전체 detail 저장**(문항별 정답 포함 — 교사가 봐야 함).
6. **안전한 결과만 반환** (아래 §보안).

### Response (성공) — ⚠ 정답 비노출
```json
{ "ok": true, "data": {
  "name": "홍길동",
  "subject": "수학", "unit": "3단원",
  "count": 10,
  "correct": 7,
  "score": 70,
  "detail": [
    { "q": 1, "type": "mc",    "multi": false, "isCorrect": true,  "needsReview": false },
    { "q": 3, "type": "short", "multi": false, "isCorrect": false, "needsReview": true  }
  ]
}}
```

### 보안 — 두 종류의 "correct" 구분 (불변식 2-2)
- **최상위 `correct` = 맞은 *개수*** → 학생에게 노출 OK ("7 / 10 정답").
- **문항별 `correct` = 그 문제의 *정답*** → **응답에서 반드시 제거.**
- 문항별 응답 허용 필드: `q, type, multi, isCorrect, needsReview` 만.
  `correct`, `student`, `manualOverride`는 학생 응답에서 제외(DB에는 저장).

### 스켈레톤 (TS, Deno)
```ts
// supabase/functions/submit_for_student/index.ts
import { createClient } from "jsr:@supabase/supabase-js@2";
import { gradeSubmission_ } from "../_shared/grading.js";   // 기존 로직 그대로

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const normalizeCode = (s: string) =>
  (s ?? "").trim().toUpperCase().replace(/[^A-Z0-9\-_]/g, "");

Deno.serve(async (req) => {
  try {
    const { teacherCode, examId, name, answers } = await req.json();
    if (!teacherCode || !examId || !name || !Array.isArray(answers))
      return json({ ok:false, error:"필수 항목 누락" });

    const { data: t } = await admin.from("teachers")
      .select("id").eq("code", normalizeCode(teacherCode)).maybeSingle();
    if (!t) return json({ ok:false, error:"존재하지 않는 선생님 코드" });

    const { data: exam } = await admin.from("answer_keys")
      .select("*").eq("id", examId).eq("teacher_id", t.id).maybeSingle();
    if (!exam) return json({ ok:false, error:"시험을 찾을 수 없습니다." });

    // exam.questions(jsonb) → gradeSubmission_가 기대하는 형태로 전달
    const graded = gradeSubmission_({ ...exam, questions: exam.questions }, answers);

    await admin.from("submissions").insert({
      teacher_id: t.id, exam_id: examId, name: String(name).trim(),
      subject: exam.subject, unit: exam.unit,
      count: graded.count, correct: graded.correct, score: graded.score,
      detail: graded.detail,                       // 전체 저장(정답 포함)
    });

    return json({ ok:true, data:{                  // ⚠ 정답 제거 후 반환
      name: String(name).trim(),
      subject: exam.subject, unit: exam.unit,
      count: graded.count, correct: graded.correct, score: graded.score,
      detail: graded.detail.map((d: any) => ({
        q: d.q, type: d.type, multi: d.multi,
        isCorrect: d.isCorrect, needsReview: d.needsReview,
      })),
    }});
  } catch (e) {
    return json({ ok:false, error: String((e as Error).message ?? e) });
  }
});

const json = (o: unknown) =>
  new Response(JSON.stringify(o), { headers: { "Content-Type":"application/json" } });
```

---

## 정리: 액션 → 새 경로 매핑

| 기존 action | 새 경로 |
|---|---|
| `info` | RPC `get_public_info()` |
| `register_teacher` | **Edge Function** `register_teacher` |
| `login_teacher` | 클라이언트 `auth.signInWithPassword` |
| `check_teacher_exists` | RPC `get_teacher_public(code)` |
| `list_exams_for_student` | RPC `list_exams_for_student(code)` (정답 제거) |
| `submit_for_student` | **Edge Function** `submit_for_student` (채점) |
| `list_exams` | `supabase.from('answer_keys').select()` (RLS) |
| `add_exam` | `supabase.from('answer_keys').insert()` (RLS) |
| `delete_exam` | `supabase.from('answer_keys').delete()` (RLS) |
| `list_submissions` | `supabase.from('submissions').select()` (RLS) |
| `update_submission` | `supabase.from('submissions').update()` (RLS) + 트리거 점수 재계산 |
