-- ============================================================
-- OMR 자동 채점 시스템 — 통합 설치 SQL (exam-omr 프로젝트용)
-- 사용법: Supabase 대시보드 → SQL Editor → 이 파일 전체를 붙여넣고,
--        맨 아래 '학교 설정' 두 값을 고친 뒤 → Run 한 번.
-- (supabase/migrations 5개를 순서대로 합친 것 + 학교 설정)
-- ============================================================


-- ################################################################
-- ## 20260630151218_init_omr_schema.sql
-- ################################################################
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

-- ################################################################
-- ## 20260705014542_submissions_immutable.sql
-- ################################################################
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

-- ################################################################
-- ## 20260705015639_classes_students_pin.sql
-- ################################################################
-- ============================================================
-- 반(학급) 관리 + 학생 PIN (C안: 첫 입장 시 학생이 PIN 자체 설정)
--
-- 결정 사항:
--  * 교사는 여러 반을 만들어 관리 (여러 학급 수업, 연도별 누적).
--  * 학생은 [선생님 코드 → 반 선택 → 이름 + PIN] 으로 입장.
--    - 그 반에 처음 오는 이름이면 학생 등록 + 입력한 PIN 설정.
--    - 기존 학생이면 PIN 검증 (불일치 → 거부).
--  * PIN 분실: 교사가 반 관리에서 초기화(pin_hash=null) → 다음 입장 시 새 PIN 설정.
--  * 반이 다르면 학생이 섞이지 않음: 학생은 반 소속, 제출 불변성 unique 도
--    (exam_id, name) → (exam_id, student_id) 로 교체(다른 반 동명이인 각자 제출 가능).
--  * 시험(answer_keys.class_id): null = 모든 반 공통, 지정 시 해당 반만 응시 가능.
-- ============================================================

-- ---------- 1. 테이블 ----------
create table public.classes (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null references public.teachers(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (teacher_id, name)
);

create table public.students (
  id          uuid primary key default gen_random_uuid(),
  class_id    uuid not null references public.classes(id) on delete cascade,
  teacher_id  uuid not null references public.teachers(id) on delete cascade,
  name        text not null,
  pin_salt    text,
  pin_hash    text,               -- null = PIN 미설정(첫 입장 전 또는 교사가 초기화)
  pin_set_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (class_id, name)         -- 같은 반 안에서 이름 유일
);

create index on public.classes  (teacher_id);
create index on public.students (teacher_id);
create index on public.students (class_id);

-- 기존 테이블 확장
alter table public.answer_keys add column class_id   uuid references public.classes(id)  on delete set null;  -- null = 모든 반 공통
alter table public.submissions add column class_id   uuid references public.classes(id)  on delete set null;
alter table public.submissions add column student_id uuid references public.students(id) on delete set null;

-- 제출 불변성 unique 교체: 이름 기반 → 학생 기반 (반이 다른 동명이인 허용)
drop index if exists submissions_exam_name_unique;
create unique index if not exists submissions_exam_student_unique
  on public.submissions (exam_id, student_id) where student_id is not null;

-- ---------- 2. RLS (교사 격리 — 불변식 2-3) ----------
alter table public.classes  enable row level security;
alter table public.students enable row level security;

create policy "teacher manages own classes" on public.classes
  for all using (auth.uid() = teacher_id) with check (auth.uid() = teacher_id);

-- 학생 행: 교사는 조회/수정(PIN 초기화)/삭제만. insert 는 student_enter(RPC)만 수행.
create policy "teacher reads own students" on public.students
  for select using (auth.uid() = teacher_id);
create policy "teacher updates own students" on public.students
  for update using (auth.uid() = teacher_id) with check (auth.uid() = teacher_id);
create policy "teacher deletes own students" on public.students
  for delete using (auth.uid() = teacher_id);

-- ---------- 3. PIN 해시 ----------
-- Supabase 는 pgcrypto 를 extensions 스키마에 두므로 search_path 에 둘 다 포함.
create or replace function public.hash_pin(p_pin text, p_salt text)
returns text language sql immutable set search_path = public, extensions as $$
  select encode(digest(p_pin || ':' || p_salt, 'sha256'), 'hex');
$$;

-- ---------- 4. 학생 입장/등록 RPC (익명 허용) ----------
-- status: 'registered'(첫 등록+PIN 설정) | 'pin_reset'(초기화 후 새 PIN 설정) | 'ok'(검증 통과)
create or replace function public.student_enter(p_class_id uuid, p_name text, p_pin text)
returns table (student_id uuid, status text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  s public.students%rowtype;
  c public.classes%rowtype;
  v_name text := trim(coalesce(p_name, ''));
  v_salt text;
begin
  if v_name = '' or length(v_name) > 50 then
    raise exception '이름이 올바르지 않습니다.';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'PIN은 4~8자리 숫자로 입력해주세요.';
  end if;

  select * into c from public.classes where id = p_class_id;
  if not found then
    raise exception '반을 찾을 수 없습니다.';
  end if;

  select * into s from public.students st where st.class_id = p_class_id and st.name = v_name;

  if not found then
    -- 첫 입장: 학생 등록 + 입력한 PIN 을 내 PIN 으로 설정 (반 정원 상한으로 스팸 방지)
    if (select count(*) from public.students st where st.class_id = p_class_id) >= 200 then
      raise exception '반 인원이 가득 찼습니다. 선생님께 문의하세요.';
    end if;
    v_salt := gen_random_uuid()::text;
    return query
      insert into public.students (class_id, teacher_id, name, pin_salt, pin_hash, pin_set_at)
      values (p_class_id, c.teacher_id, v_name, v_salt, public.hash_pin(p_pin, v_salt), now())
      returning id, 'registered'::text;
    return;
  end if;

  if s.pin_hash is null then
    -- 교사가 PIN 초기화함 → 지금 입력한 PIN 을 새 PIN 으로 설정
    v_salt := gen_random_uuid()::text;
    update public.students
      set pin_salt = v_salt, pin_hash = public.hash_pin(p_pin, v_salt), pin_set_at = now()
      where id = s.id;
    return query select s.id, 'pin_reset'::text;
    return;
  end if;

  if s.pin_hash <> public.hash_pin(p_pin, s.pin_salt) then
    raise exception 'PIN이 일치하지 않습니다. 잊어버렸다면 선생님께 초기화를 요청하세요.';
  end if;

  return query select s.id, 'ok'::text;
end;
$$;

-- ---------- 5. 제출 시 PIN 재검증 (Edge Function 전용 — 익명 직접 호출 차단) ----------
create or replace function public.student_verify(p_class_id uuid, p_name text, p_pin text)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  s public.students%rowtype;
begin
  select * into s from public.students st
    where st.class_id = p_class_id and st.name = trim(coalesce(p_name, ''));
  if not found or s.pin_hash is null or p_pin is null
     or s.pin_hash <> public.hash_pin(p_pin, s.pin_salt) then
    return null;
  end if;
  return s.id;
end;
$$;

-- ---------- 6. 학생용 반 목록 (선생님 코드 → 반 이름들만 공개) ----------
create or replace function public.list_classes_public(p_teacher_code text)
returns table (id uuid, name text)
language sql security definer set search_path = public as $$
  select c.id, c.name
  from public.classes c
  join public.teachers t on t.id = c.teacher_id
  where t.code = public.normalize_code(p_teacher_code)
  order by c.name;
$$;

-- ---------- 7. 학생용 시험 목록을 반 기준으로 교체 ----------
-- 모든 반 공통(class_id null) + 해당 반 지정 시험만. 정답 제거({q,type,multi})는 동일 유지(불변식 2-2).
drop function if exists public.list_exams_for_student(text);
create or replace function public.list_exams_for_student(p_class_id uuid)
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
  join public.classes c on c.teacher_id = ak.teacher_id
  where c.id = p_class_id
    and (ak.class_id is null or ak.class_id = c.id)
  order by ak.created_at desc;
$$;

-- ---------- 8. 실행 권한 ----------
grant execute on function public.student_enter(uuid, text, text)      to anon, authenticated;
grant execute on function public.list_classes_public(text)            to anon, authenticated;
grant execute on function public.list_exams_for_student(uuid)         to anon, authenticated;
-- PIN 해시/검증은 익명 직접 호출 차단 (Edge Function 의 service_role 만)
revoke execute on function public.hash_pin(text, text)                from public, anon, authenticated;
revoke execute on function public.student_verify(uuid, text, text)    from public, anon, authenticated;
grant  execute on function public.student_verify(uuid, text, text)    to service_role;

-- ################################################################
-- ## 20260705101041_student_history_exam_edit.sql
-- ################################################################
-- ============================================================
-- (1) 학생 "내 성적 보기" RPC — 이름+PIN 으로 본인 제출 기록만 (정답 비노출, 불변식 2-2)
-- (2) 정답지 수정 가드 — 제출된 응시가 있으면 문항/정답 수정 금지 (복제 유도)
-- ============================================================

-- ---------- 1. student_history ----------
-- PIN 검증(student_verify 재사용) 후 본인 submissions 만 반환.
-- detail 은 안전 필드만: q/type/multi + 교사 정정 반영된 isCorrect(effective),
-- 검토 대기 여부(needsReview && 미정정). correct(정답)/student(입력값)/manualOverride 는 제외.
create or replace function public.student_history(p_class_id uuid, p_name text, p_pin text)
returns table (
  id uuid, subject text, unit text, count int, correct int, score int,
  submitted_at timestamptz, detail jsonb
)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_student uuid;
begin
  v_student := public.student_verify(p_class_id, p_name, p_pin);
  if v_student is null then
    raise exception '이름 또는 PIN이 올바르지 않습니다.';
  end if;
  return query
    select s.id, s.subject, s.unit, s.count, s.correct, s.score, s.submitted_at,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'q',     d->'q',
          'type',  d->'type',
          'multi', coalesce(d->'multi', 'false'::jsonb),
          -- 교사 수동 정정 반영: effective = manualOverride != null ? manualOverride : isCorrect
          'isCorrect', case when jsonb_typeof(d->'manualOverride') = 'boolean'
                            then d->'manualOverride'
                            else coalesce(d->'isCorrect', 'false'::jsonb) end,
          -- 정정 완료된 문항은 더 이상 검토 대기가 아님
          'needsReview', case when jsonb_typeof(d->'manualOverride') = 'boolean'
                              then 'false'::jsonb
                              else coalesce(d->'needsReview', 'false'::jsonb) end
        ) order by (d->>'q')::int), '[]'::jsonb)
        from jsonb_array_elements(s.detail) d
      ) as detail
    from public.submissions s
    where s.student_id = v_student
    order by s.submitted_at asc;
end;
$$;
grant execute on function public.student_history(uuid, text, text) to anon, authenticated;

-- ---------- 2. 정답지 수정 가드 ----------
-- 제출된 응시가 있는 시험의 문항/정답(questions·count·choices) 변경을 DB 레벨에서 차단.
-- 과목/단원/응시 반(class_id) 등 메타 변경은 허용 (채점 결과에 영향 없음 — 제출 시점 값이 저장됨).
create or replace function public.prevent_answer_key_edit_after_submission()
returns trigger language plpgsql as $$
begin
  if (new.questions is distinct from old.questions
      or new.count    is distinct from old.count
      or new.choices  is distinct from old.choices)
     and exists (select 1 from public.submissions where exam_id = old.id) then
    raise exception '이미 제출된 응시가 있어 문항/정답을 수정할 수 없습니다. 복제해서 새 정답지를 만드세요.';
  end if;
  return new;
end;
$$;
create trigger trg_answer_keys_edit_guard
  before update on public.answer_keys
  for each row execute function public.prevent_answer_key_edit_after_submission();

-- ################################################################
-- ## 20260705111933_class_delete_guard.sql
-- ################################################################
-- ============================================================
-- (1) 반 삭제 안전장치 — 전용 시험이 있는 반은 DB 가 삭제를 거부(restrict)
--     기존 on delete set null 은 반 삭제 시 그 반 전용 시험이 조용히
--     '모든 반 공통'으로 바뀌어 다른 반에 노출되는 문제가 있었음.
--     정책(확정): 프론트가 삭제 시점에 교사에게 물어보고,
--       - 교사가 확인하면 전용 시험(과 응시 결과)을 먼저 삭제한 뒤 반을 삭제
--       - 취소하면 중단 (시험의 응시 반을 공통/다른 반으로 수정하도록 안내)
--     DB restrict 는 프론트를 우회하는 모든 경로의 최후 방어선.
-- (2) student_enter 동시 첫-등록 레이스 시 원문 duplicate key 에러 대신
--     친절한 안내 메시지 반환.
-- ============================================================

-- ---------- 1. answer_keys.class_id FK: set null → restrict ----------
alter table public.answer_keys drop constraint answer_keys_class_id_fkey;
alter table public.answer_keys add constraint answer_keys_class_id_fkey
  foreign key (class_id) references public.classes(id) on delete restrict;

-- ---------- 2. student_enter: 동시 등록 unique 위반 → 친절한 메시지 ----------
create or replace function public.student_enter(p_class_id uuid, p_name text, p_pin text)
returns table (student_id uuid, status text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  s public.students%rowtype;
  c public.classes%rowtype;
  v_name text := trim(coalesce(p_name, ''));
  v_salt text;
begin
  if v_name = '' or length(v_name) > 50 then
    raise exception '이름이 올바르지 않습니다.';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'PIN은 4~8자리 숫자로 입력해주세요.';
  end if;

  select * into c from public.classes where id = p_class_id;
  if not found then
    raise exception '반을 찾을 수 없습니다.';
  end if;

  select * into s from public.students st where st.class_id = p_class_id and st.name = v_name;

  if not found then
    -- 첫 입장: 학생 등록 + 입력한 PIN 을 내 PIN 으로 설정 (반 정원 상한으로 스팸 방지)
    if (select count(*) from public.students st where st.class_id = p_class_id) >= 200 then
      raise exception '반 인원이 가득 찼습니다. 선생님께 문의하세요.';
    end if;
    v_salt := gen_random_uuid()::text;
    begin
      return query
        insert into public.students (class_id, teacher_id, name, pin_salt, pin_hash, pin_set_at)
        values (p_class_id, c.teacher_id, v_name, v_salt, public.hash_pin(p_pin, v_salt), now())
        returning id, 'registered'::text;
    exception when unique_violation then
      -- 동시에 같은 이름이 먼저 등록됨(레이스) → 원문 duplicate key 대신 안내
      raise exception '방금 같은 이름으로 등록이 완료되었어요. 본인이라면 그때 설정한 PIN으로 다시 입장해 주세요.';
    end;
    return;
  end if;

  if s.pin_hash is null then
    -- 교사가 PIN 초기화함 → 지금 입력한 PIN 을 새 PIN 으로 설정
    v_salt := gen_random_uuid()::text;
    update public.students
      set pin_salt = v_salt, pin_hash = public.hash_pin(p_pin, v_salt), pin_set_at = now()
      where id = s.id;
    return query select s.id, 'pin_reset'::text;
    return;
  end if;

  if s.pin_hash <> public.hash_pin(p_pin, s.pin_salt) then
    raise exception 'PIN이 일치하지 않습니다. 잊어버렸다면 선생님께 초기화를 요청하세요.';
  end if;

  return query select s.id, 'ok'::text;
end;
$$;

-- ################################################################
-- ## 학교 설정 — ★ 아래 두 값을 실제 값으로 고친 뒤 실행하세요 ★
-- ################################################################
insert into public.settings (key, value) values
  ('schoolName', '여기에_학교이름'),          -- 예: '서울예술중학교'
  ('joinCode',   '여기에_교사가입코드')       -- 교사들에게만 알려줄 코드
on conflict (key) do update set value = excluded.value;
