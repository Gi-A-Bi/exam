-- ============================================================
-- OMR 자동 채점 시스템 — Supabase 스키마 초안
-- 전제(채팅 트랙에서 확정 필요):
--   * 교사 로그인 = 이메일(Supabase Auth) + 공개 teacher_code 분리
--   * 학생(익명) = 테이블 직접 접근 금지, RPC/Edge Function 경유
--   * 채점 = Edge Function에서 기존 grading.js 재사용 (plpgsql 재구현 금지)
-- 배포 모델: 학교별 1 Supabase 프로젝트 (school은 프로젝트 단위로 암묵)
-- ============================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ============================================================
-- 1. 테이블
-- ============================================================

-- 교사 프로필 (로그인 비밀번호는 auth.users가 관리 → pwHash/salt 없음)
create table public.teachers (
  id          uuid primary key references auth.users(id) on delete cascade,
  code        text unique not null,           -- 학생에게 알려주는 공개 코드 (정규화: 대문자)
  name        text not null,
  created_at  timestamptz not null default now()
);

-- 정답지 (questions에 정답 포함 → 학생은 절대 직접 SELECT 불가)
create table public.answer_keys (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null references public.teachers(id) on delete cascade,
  subject     text not null,
  unit        text not null,
  count       int  not null,
  choices     int  not null default 5,
  questions   jsonb not null,                 -- 기존 questionsJson을 jsonb로 (형식 동일)
  created_at  timestamptz not null default now()
);
-- 문항 형식(보존):
--   {"q":1,"type":"mc","answer":3}
--   {"q":2,"type":"mc","multi":true,"answers":[1,3]}
--   {"q":3,"type":"short","answers":["답1","답2"]}

-- 응시 결과
create table public.submissions (
  id           uuid primary key default gen_random_uuid(),
  teacher_id   uuid not null references public.teachers(id) on delete cascade,
  exam_id      uuid not null references public.answer_keys(id) on delete cascade,
  name         text not null,                 -- 학생 이름(또는 학번/별명 — 정책 확정 시 반영)
  subject      text not null,
  unit         text not null,
  count        int  not null,
  correct      int  not null,
  score        int  not null,
  detail       jsonb not null,                -- {q,type,multi,student,correct,isCorrect,needsReview,manualOverride}
  submitted_at timestamptz not null default now()
);

-- 프로젝트(=학교) 설정: schoolName, joinCode 등
create table public.settings (
  key   text primary key,
  value text
);

create index on public.answer_keys (teacher_id);
create index on public.submissions (teacher_id);
create index on public.submissions (exam_id);

-- ============================================================
-- 2. RLS — DB 레벨에서 교사 격리 강제 (불변식 2-3)
-- ============================================================

alter table public.teachers    enable row level security;
alter table public.answer_keys enable row level security;
alter table public.submissions enable row level security;
alter table public.settings    enable row level security;

-- 교사: 본인 프로필만
create policy "teacher reads own profile" on public.teachers
  for select using (auth.uid() = id);
create policy "teacher updates own profile" on public.teachers
  for update using (auth.uid() = id) with check (auth.uid() = id);
-- (insert는 회원가입 Edge Function에서 service_role로 처리 — 아래 §5 참고)

-- 교사: 본인 정답지 전체 권한. 익명 접근 정책 없음 → anon은 직접 SELECT 불가(정답 보호)
create policy "teacher manages own exams" on public.answer_keys
  for all using (auth.uid() = teacher_id) with check (auth.uid() = teacher_id);

-- 교사: 본인 응시 결과 조회/수정. 학생 insert는 Edge Function(service_role)로만
create policy "teacher reads own submissions" on public.submissions
  for select using (auth.uid() = teacher_id);
create policy "teacher updates own submissions" on public.submissions
  for update using (auth.uid() = teacher_id) with check (auth.uid() = teacher_id);
create policy "teacher deletes own submissions" on public.submissions
  for delete using (auth.uid() = teacher_id);

-- settings: 직접 접근 정책 없음 → 공개가 필요한 값만 아래 RPC로 노출(joinCode는 절대 비노출)

-- ============================================================
-- 3. 점수 재계산 트리거 (교사 수동 정정 시)
--    detail의 manualOverride/isCorrect로 correct·score 재계산.
--    ※ 여기서 하는 건 '불리언 집계'일 뿐, 퍼지 채점이 아님 → plpgsql로 안전.
-- ============================================================

create or replace function public.recompute_submission_score()
returns trigger language plpgsql as $$
declare
  c   int := 0;
  rec jsonb;
  eff boolean;
begin
  for rec in select value from jsonb_array_elements(new.detail) loop
    if jsonb_typeof(rec->'manualOverride') = 'boolean' then
      eff := (rec->>'manualOverride')::boolean;           -- 수동 정정 우선
    else
      eff := coalesce((rec->>'isCorrect')::boolean, false);
    end if;
    if eff then c := c + 1; end if;
  end loop;
  new.correct := c;
  new.score   := case when new.count > 0
                      then round(c::numeric / new.count * 100)::int
                      else 0 end;
  return new;
end;
$$;

create trigger trg_recompute_submission
  before update on public.submissions
  for each row execute function public.recompute_submission_score();

-- ============================================================
-- 4. 학생(익명) 경로용 RPC — 정답 제거 보장 (불변식 2-2)
--    SECURITY DEFINER로 RLS를 우회하되, 응답에서 정답 컬럼을 제거.
-- ============================================================

-- 4-0. 코드 정규화 — 프론트/Edge 의 normalizeCode 와 동일 규칙
--      (대문자화 + [A-Z0-9_-] 외 제거). 학생이 공백·기호를 섞어 입력해도 저장된 코드와 매칭.
create or replace function public.normalize_code(p text)
returns text language sql immutable as $$
  select regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9_-]', '', 'g');
$$;

-- 4-1. 공개 정보(학교명만)
create or replace function public.get_public_info()
returns table (school_name text)
language sql security definer set search_path = public as $$
  select value from public.settings where key = 'schoolName';
$$;

-- 4-2. 교사 존재 확인 (code → name). 교사 테이블 전체 노출 없이 공개 필드만.
create or replace function public.get_teacher_public(p_code text)
returns table (code text, name text)
language sql security definer set search_path = public as $$
  select code, name from public.teachers where code = public.normalize_code(p_code);
$$;

-- 4-3. 학생용 시험 목록 — answer/answers 제거, {q,type,multi}만 노출
create or replace function public.list_exams_for_student(p_teacher_code text)
returns table (
  id uuid, subject text, unit text, count int, choices int,
  questions jsonb, created_at timestamptz
)
language sql security definer set search_path = public as $$
  select
    ak.id, ak.subject, ak.unit, ak.count, ak.choices,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'q',     q->'q',
        'type',  q->'type',
        'multi', coalesce(q->'multi', 'false'::jsonb)
      )), '[]'::jsonb)
      from jsonb_array_elements(ak.questions) q
    ) as questions,
    ak.created_at
  from public.answer_keys ak
  join public.teachers t on t.id = ak.teacher_id
  where t.code = public.normalize_code(p_teacher_code)
  order by ak.created_at desc;
$$;

-- 익명 호출 허용 (위 함수들만)
grant execute on function public.get_public_info()                to anon, authenticated;
grant execute on function public.get_teacher_public(text)         to anon, authenticated;
grant execute on function public.list_exams_for_student(text)     to anon, authenticated;

-- ============================================================
-- 5. Edge Function으로 처리할 부분 (이 SQL에는 없음 — 계약만 명시)
-- ============================================================
-- (a) register_teacher  : joinCode 검증(비노출) → auth signUp → teachers insert(코드 중복/정규화).
--                         joinCode를 클라이언트에 노출하면 안 되므로 반드시 서버측.
-- (b) submit_for_student: answer_keys 조회(service_role) → grading.js로 채점
--                         → submissions insert → 안전한 결과만 반환
--                         (반환 detail 허용 필드: q,type,multi,isCorrect,needsReview — correct 제외).
--    ⚠ 채점 로직은 기존 grading.js를 그대로 임포트해 사용. plpgsql로 재구현 금지(불변식 2-1).
-- ============================================================
