-- ============================================================
-- 학생 제출 불변성 (결정: 제출한 결과는 수정/재제출 불가)
--
-- 학생 경로에는 원래 submissions 에 대한 update 권한이 없음
-- (anon 용 RLS 정책 자체가 없고, insert 는 Edge Function(service_role)만 수행).
-- 여기에 더해, 같은 시험(exam_id)에 같은 이름(name)으로의 재제출(insert)을
-- DB 레벨에서 차단해 Edge Function 의 중복 검사(동시 제출 레이스 포함)를 하드하게 보강.
--
-- 주의:
--  * 동명이인 학생은 같은 시험을 각자 제출할 수 없게 됨 → 학번/PIN 등
--    학생 식별 체계 도입 논의와 연계해 개선 예정.
--  * 잘못 제출된 행은 교사가 결과 화면에서 삭제(RLS delete own)하면
--    해당 학생이 다시 제출할 수 있음.
--  * 교사의 수동 정정(update)은 exam_id/name 을 바꾸지 않으므로 영향 없음.
-- ============================================================

create unique index if not exists submissions_exam_name_unique
  on public.submissions (exam_id, name);
