# CLAUDE.md — OMR 자동 채점 시스템

이 파일은 Claude Code가 매 작업마다 먼저 읽는 프로젝트 컨텍스트입니다.
**아래의 "절대 규칙(불변식)"을 어기는 변경은 어떤 경우에도 하지 마세요.**

---

## 0. 프로젝트 한 줄 요약

교사가 정답지를 등록하고, 학생이 코드로 접속해 시험에 응시하면 자동 채점되는 웹 시스템.
현재 **Google Apps Script + Google Sheets**로 운영 중이며, **Supabase + 정적 프론트엔드**로의 이전을 진행 중.

---

## 1. 작업 방식 (병렬 진행 전제)

이 프로젝트는 두 트랙으로 동시에 진행됩니다.

- **결정/설계 트랙**: 아키텍처 선택, 데이터 모델 변경, 배포 모델 등은 채팅(Claude)에서 사람과 논의해 확정합니다.
- **실행 트랙(여기, Claude Code)**: 확정된 계획을 실제 코드로 옮기고, 테스트·커밋합니다.

따라서 Claude Code는:

- **이미 합의된 작업만 실행**하세요. 아직 확정되지 않은 설계 결정(예: Firebase로 바꿀지, 실명 대신 학번을 쓸지)에 부딪히면 **임의로 결정하지 말고 멈춰서 질문**하세요.
- 작업은 항상 **작게 쪼개서** 진행하고, 각 단계 후 **테스트로 동작을 확인한 뒤** 다음으로 넘어갑니다.
- 모든 변경은 git 위에서 합니다. 채점 로직 등 민감한 부분은 **별도 브랜치**에서 작업하고, `git diff`로 검토 가능하게 남기세요.

---

## 2. 절대 규칙 (불변식) — 위반 금지

### 2-1. 채점 결과는 비트 단위로 동일해야 함
다음 함수들의 **입출력 동작은 기존과 완전히 같아야 합니다.** 리팩터링(모듈 분리, 정리)은 허용되지만, 같은 입력에 다른 결과가 나오면 안 됩니다.

- `gradeSubmission_` — 전체 채점 오케스트레이션
- `gradeMcMulti_` — 복수정답 채점 (정렬된 집합 비교: 개수 일치 + 원소별 일치)
- `normalize_` — 답안 정규화 (trim → 소문자 → 공백 제거 → `.,!?'"·` 제거)
- `isAmbiguous_` — 주관식 "검토 필요" 판정 (Levenshtein 기반 유사도)
- `levenshtein_` — 편집 거리

> 이 다섯 함수는 시스템의 핵심 가치입니다. **새로 짜지 말고 그대로 이식**하세요.
> 이전 시 가장 먼저 할 일은 이 함수들을 공용 모듈(예: `grading.js`)로 분리하고,
> **동일 입력 → 동일 출력**을 검증하는 회귀 테스트를 작성하는 것입니다.

`isAmbiguous_`의 판정 규칙(보존 대상):
- `maxLen <= 4` 이고 거리 `=== 1` → 검토 필요
- `maxLen > 4` 이고 `거리/maxLen <= 0.3` → 검토 필요
- 한쪽이 다른 쪽의 부분 문자열이고 길이 차 `<= 3` → 검토 필요

채점 보조 규칙(보존 대상):
- 점수 = `round(맞은개수 / 문항수 * 100)`
- 교사 수동 정정: `effective = manualOverride != null ? manualOverride : isCorrect`

### 2-2. 학생에게 정답을 절대 노출하지 않음 (v5.2 보안 핵심)
- 학생 답안 제출 응답(`submit_for_student`)의 `detail`에는 **정답(`correct`) 필드가 들어가면 안 됨.**
  허용 필드: `q, type, multi, isCorrect, needsReview` 만.
- 학생용 시험 목록(`list_exams_for_student`)은 정답을 가리고 `{ q, type, multi }`만 노출.
- 교사용 조회(`list_submissions`)는 정답 포함 전체 `detail` 노출(이쪽은 정상).

> 이전 후에도 이 비대칭이 유지되어야 합니다. Supabase로 가면 **RLS/뷰로 학생 경로에서 정답 컬럼이 절대 나가지 않도록** 설계하세요.

### 2-3. 교사 간 데이터 격리
- 한 교사는 **자기 데이터(answer_keys, submissions)만** 조회/수정/삭제할 수 있어야 함.
- 현재는 코드에서 `filter(it.teacherCode === myCode)`로 거르지만, 이전 후에는 **DB 레벨(RLS)에서 강제**하는 것이 목표.

---

## 3. 현재 시스템 (사실 — 보존 대상)

### 3-1. 스택
- 백엔드: Google Apps Script (`doGet`/`doPost`, JSON over POST)
- DB: Google Sheets (시트 4개를 테이블처럼 사용)
- 프론트엔드: 단일 HTML(`index`)을 Apps Script가 서빙. 바닐라 JS.
- 인증: 자체 토큰 (SHA-256 해시 + 서명)

### 3-2. 데이터 모델 (시트 = 테이블)
```
teachers     : code, name, pwHash, salt, createdAt
answer_keys  : id, teacherCode, subject, unit, count, choices, questionsJson, createdAt
submissions  : id, teacherCode, examId, name, subject, unit, count, correct, score, detailJson, submittedAt
settings     : key, value
```
- `spreadsheetId`는 시트가 아니라 ScriptProperties에 저장됨.
- `settings`의 키: `schoolName`, `tokenSecret`. (가입코드(joinCode)는 v5.2에서 제거됨)

### 3-3. 문항 형식 (`answer_keys.questionsJson` 안의 각 항목)
```js
// 객관식 단일
{ q: 1, type: 'mc', answer: 3 }
// 객관식 복수
{ q: 2, type: 'mc', multi: true, answers: [1, 3] }
// 주관식 (복수 정답 허용)
{ q: 3, type: 'short', answers: ['답1', '답2'] }
```

### 3-4. 학생 제출 답안 형식 (`submit_for_student`의 `answers`)
```js
{ q: 1, answer: 3 }          // 객관식 단일
{ q: 2, answer: [1, 3] }     // 객관식 복수
{ q: 3, answer: '정답텍스트' } // 주관식
```

### 3-5. 채점 결과 detail 형식 (`submissions.detailJson` 안의 각 항목)
```js
{ q, type, multi, student, correct, isCorrect, needsReview, manualOverride }
```
- `manualOverride`: 교사가 정/오를 수동으로 뒤집은 값. 미정정이면 `null`.

### 3-6. API 액션 목록
**인증 불필요(public):**
`info`, `register_teacher`, `login_teacher`, `check_teacher_exists`,
`list_exams_for_student`, `submit_for_student`

**인증 필요(교사 토큰):**
`list_exams`, `add_exam`, `delete_exam`, `list_submissions`, `update_submission`

### 3-7. 인증 방식 (현재)
- 비밀번호: `pwHash = SHA-256_hex(password + ':' + salt)`, salt는 가입 시 UUID.
- 토큰: `base64WebSafe(code + '|' + exp + '|' + sig)`,
  `sig = SHA-256_hex(code + '|' + exp, tokenSecret).slice(0, 32)`, 만료 `exp = now + 12시간`.
- 교사 코드 정규화: 대문자화 후 `[A-Z0-9\-_]` 외 문자 제거(`normalizeCode_`).
- 가입 시 비밀번호 6자 이상, 코드 3자 이상 + 영문자 1자 이상 포함(시트 형변환 방지). 가입코드 검증은 제거됨.

### 3-8. 알려진 성능 문제 (이전의 주된 동기)
- `listAll_`이 매 요청마다 **시트 전체를 읽음** → 데이터가 쌓이면 선형적으로 느려짐.
- Apps Script 콜드 스타트 + 동시 실행/할당량 제한.
- `insert_`의 ID 생성(`Date.now()+random`)은 동시 제출 시 충돌 여지.

---

## 4. 이전 목표 (논의 중 — 확정 전 임의 변경 금지)

> 아래는 채팅 트랙에서 논의 중인 방향입니다. **확정되기 전에는 실행하지 말고**,
> 해당 작업 지시가 들어오면 그때 진행하세요.

- **목표 스택(유력)**: 정적 프론트엔드(Cloudflare Pages/Vercel) + Supabase(Postgres + Auth + RLS).
  - 자체 토큰/해시 코드는 Supabase Auth로 대체.
  - `filter(teacherCode === myCode)` 로직은 RLS로 대체.
- **프론트엔드**: 당장은 바닐라 JS 유지(React 재작성은 보류). 백엔드 호출부만 교체.
- **배포 모델(유력)**: 학교별 자체 소유(각 학교가 자기 Supabase 프로젝트) + 쉬운 배포 템플릿.
  - 이유: 학생 이름·점수는 미성년자 개인정보 → 단일 호스팅 시 책임 범위가 과도.
- **개인정보 최소화(검토 중)**: 실명 대신 학번/별명 기본값. — *결정 전 변경 금지.*

### 권장 이전 순서
1. 저장소를 git으로 정리.
2. 채점 로직 5개 함수를 `grading.js`로 분리 + 회귀 테스트 작성.
3. Supabase 스키마(테이블 4개 대응) + RLS 정책 설계.
4. `callApi`의 액션을 **하나씩** Supabase 호출로 교체 (로그인 → 정답지 → 제출 → 결과 조회 순).
5. 정적 호스팅 배포 + 학교별 배포 템플릿 정리.

> 참고: 전면 이전 전 "빠른 개선"으로 Apps Script에 `CacheService` 캐싱을 넣어
> 시트 전체 재읽기를 줄이는 선택지도 있음(별도 지시 시).

---

## 5. 작업 체크리스트 (매 변경마다)

- [ ] 이 변경이 §2 불변식(채점 동일성 / 정답 비노출 / 교사 격리)을 깨지 않는가?
- [ ] 채점 관련 변경이면 회귀 테스트가 통과하는가?
- [ ] 확정되지 않은 설계 결정을 임의로 내리지 않았는가? (애매하면 질문)
- [ ] 변경이 작은 단위로 커밋되어 `git diff`로 검토 가능한가?
