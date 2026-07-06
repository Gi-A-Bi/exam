# 배포 가이드 — OMR 자동 채점 시스템 (Supabase 버전)

이 문서만 따라 하면 학생·교사에게 공유할 **웹 링크**가 생깁니다. 약 15분 소요.
준비물: Supabase 계정(무료, https://supabase.com — 구글 계정으로 가입 가능).

> ⚠ 배포 대상은 **`claude/grading-refactor-golden-master-enp7dy` 브랜치의 `index.html`** 입니다.
> main 브랜치의 index.html 은 옛(GAS) 버전이므로 사용하지 마세요.

---

## 1단계. Supabase 프로젝트 만들기 (5분)

1. https://supabase.com → 로그인 → **New project**
2. 프로젝트 이름 자유, **Region: Northeast Asia (Seoul)** 권장, DB 비밀번호는 기록해 두기.
3. 생성 완료 후 **Settings → API** 에서 두 값을 복사해 두세요:
   - `Project URL` (예: `https://abcdefgh.supabase.co`)
   - `anon public` 키 (`eyJ...` 로 시작하는 긴 문자열 — 공개되어도 안전한 키)

> ⚠ 같은 화면의 `service_role` 키는 **절대** HTML/프론트에 넣지 마세요. 서버 전용입니다.

## 2단계. DB와 함수 올리기 (5분)

내 컴퓨터에 이 저장소를 받은 뒤(Node.js 설치되어 있으면 됨) 터미널에서:

```bash
git clone -b claude/grading-refactor-golden-master-enp7dy https://github.com/Gi-A-Bi/exam.git
cd exam
npx supabase login                 # 브라우저가 열리며 로그인
npx supabase link --project-ref <프로젝트ref>   # URL 의 abcdefgh 부분
npx supabase db push               # 마이그레이션 5개 적용 (테이블/RLS/함수/트리거)
npx supabase functions deploy register_teacher
npx supabase functions deploy submit_for_student
```

## 3단계. 학교 이름·가입코드 설정 (1분)

Supabase 대시보드 → **SQL Editor** → 아래를 실제 값으로 고쳐 실행:

```sql
insert into settings (key, value) values
  ('schoolName', '○○중학교'),
  ('joinCode',   '교사들에게만 알려줄 가입코드')
on conflict (key) do update set value = excluded.value;
```

## 4단계. index.html 에 내 프로젝트 연결 (1분)

`index.html` 상단(약 316행)의 두 줄을 1단계에서 복사한 값으로 교체:

```js
window.SUPABASE_URL      = "https://<프로젝트ref>.supabase.co";
window.SUPABASE_ANON_KEY = "eyJ...(anon public 키)";
```

수정 후 커밋/푸시(또는 5단계에서 파일 직접 업로드).

## 5단계. 웹에 올리기 → 링크 완성 (3분)

셋 중 하나만 하면 됩니다. **(A)가 가장 쉬움.**

**(A) Cloudflare Pages / Netlify Drop — 드래그 앤 드롭**
- https://app.netlify.com/drop (또는 Cloudflare Pages) 에 `index.html` 파일 하나를 끌어다 놓으면 끝.
- 즉시 `https://<이름>.netlify.app` 형태의 링크가 생깁니다.

**(B) GitHub Pages — 저장소에서 바로**
- 저장소 → **Settings → Pages** → Source: *Deploy from a branch*
- Branch: `claude/grading-refactor-golden-master-enp7dy`, 폴더 `/ (root)` → **Save**
- 1~2분 뒤 링크: `https://gi-a-bi.github.io/exam/`
- (4단계 수정을 이 브랜치에 푸시해 둔 상태여야 합니다)

**(C) Vercel** — New Project → 저장소 연결 → 브랜치 선택 → Deploy.

## 6단계. 동작 확인 체크리스트

1. 링크 접속 → 상단에 3단계에서 넣은 학교 이름이 보이는가
2. 선생님 가입(가입코드 필요) → 로그인 → **반 관리에서 반 1개 만들기** (반이 있어야 학생 응시 가능)
3. 정답지 등록 (응시 반: 모든 반 공통 또는 특정 반)
4. 다른 기기/시크릿 창에서 학생 입장: 선생님 코드 → 반 선택 → 이름 + PIN(첫 입장 시 설정) → 응시·제출
5. 교사 화면에서 결과 확인, 주관식 ⚠ 검토 → ⭕/❌ 정정
6. 학생 "내 성적 보기"에서 정정 반영 확인

## 문제 해결

| 증상 | 원인/조치 |
|---|---|
| 가입·제출 버튼만 실패 | Edge Function 미배포 → 2단계의 `functions deploy` 두 줄 재실행 |
| "반 목록을 불러오지 못했어요" | `db push` 누락 또는 URL/키 오타 → 4단계 값 재확인 |
| 학교 이름이 안 나옴 | 3단계 SQL 미실행 |
| 학생이 PIN 분실 | 교사 → 반 관리 → 학생 명단 → [PIN 초기화] |
