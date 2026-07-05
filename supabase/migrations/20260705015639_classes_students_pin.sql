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
