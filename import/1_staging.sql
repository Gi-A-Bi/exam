-- ============================================================
-- 옛 시스템(구글 시트) 데이터 이관 1단계 — 임시(스테이징) 테이블 생성
-- SQL Editor 에 붙여넣고 Run.
-- 컬럼명은 옛 시트의 헤더(첫 줄)와 동일: CSV 를 그대로 받기 위해 전부 text.
-- ============================================================

create table if not exists public.staging_answer_keys (
  id            text,
  "teacherCode" text,
  subject       text,
  unit          text,
  count         text,
  choices       text,
  "questionsJson" text,
  "createdAt"   text
);

create table if not exists public.staging_submissions (
  id            text,
  "teacherCode" text,
  "examId"      text,
  name          text,
  subject       text,
  unit          text,
  count         text,
  correct       text,
  score         text,
  "detailJson"  text,
  "submittedAt" text
);
