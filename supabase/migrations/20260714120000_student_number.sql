-- ============================================================
-- 학생 번호(출석번호) 추가 + 학생 식별을 '번호' 기준으로 전환
-- 결정(2026-07-14):
--  * 학생 식별 = (반, 번호). 반 안에서 번호 유일, 이름은 표시용(동명이인 허용).
--  * 번호 입력 필수(1~999). PIN 방식은 그대로.
--  * 기존(번호 없는) 학생은 다음 입장 때 '같은 반·같은 이름·번호없음'이 정확히
--    1명이면 그 학생에 번호를 부여(claim)해 기록을 잇는다.
--  * submissions.number 를 저장(비정규화) → 결과 목록/정렬/CSV 를 조인 없이 처리.
--
-- 무중단 전환: 옛 이름기반 함수(student_enter/verify/history 3-인자)는 그대로 두고
--   번호기반 오버로드를 '추가'한다. 이미 배포된 submit_for_student(옛 verify 호출)도
--   재배포 전까지 계속 동작. PostgREST 는 전달된 인자 이름으로 오버로드를 구분한다.
-- ============================================================

alter table public.students    add column if not exists number int;
alter table public.submissions add column if not exists number int;

-- 이름 유일 제약 → 번호 유일로 (동명이인 허용). 번호가 채워진 행끼리만 유일.
alter table public.students drop constraint if exists students_class_id_name_key;
create unique index if not exists students_class_number_unique
  on public.students (class_id, number) where number is not null;

-- ---------- student_enter (번호 기반) ----------
create or replace function public.student_enter(p_class_id uuid, p_number int, p_name text, p_pin text)
returns table (student_id uuid, status text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  s public.students%rowtype;
  c public.classes%rowtype;
  v_name text := trim(coalesce(p_name, ''));
  v_salt text;
  v_legacy int;
begin
  if v_name = '' or length(v_name) > 50 then
    raise exception '이름이 올바르지 않습니다.';
  end if;
  if p_number is null or p_number < 1 or p_number > 999 then
    raise exception '번호는 1~999 사이 숫자로 입력해주세요.';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'PIN은 4~8자리 숫자로 입력해주세요.';
  end if;

  select * into c from public.classes where id = p_class_id;
  if not found then
    raise exception '반을 찾을 수 없습니다.';
  end if;

  -- 1) 번호로 학생 찾기 (기본 식별)
  select * into s from public.students st where st.class_id = p_class_id and st.number = p_number;

  if not found then
    -- 2) 레거시 이관: 번호 없는 동명 학생이 정확히 1명이면 그 학생에 번호 부여
    select count(*) into v_legacy from public.students st
      where st.class_id = p_class_id and st.number is null and st.name = v_name;
    if v_legacy = 1 then
      update public.students st set number = p_number
        where st.class_id = p_class_id and st.number is null and st.name = v_name
        returning st.* into s;
      -- 아래 PIN 검증/설정 로직으로 흐름
    else
      -- 3) 신규 등록 (반 정원 상한으로 스팸 방지)
      if (select count(*) from public.students st where st.class_id = p_class_id) >= 200 then
        raise exception '반 인원이 가득 찼습니다. 선생님께 문의하세요.';
      end if;
      v_salt := gen_random_uuid()::text;
      begin
        return query
          insert into public.students (class_id, teacher_id, name, number, pin_salt, pin_hash, pin_set_at)
          values (p_class_id, c.teacher_id, v_name, p_number, v_salt, public.hash_pin(p_pin, v_salt), now())
          returning id, 'registered'::text;
      exception when unique_violation then
        raise exception '방금 같은 번호로 등록이 완료되었어요. 본인이라면 그때 설정한 PIN으로 다시 입장해 주세요.';
      end;
      return;
    end if;
  end if;

  -- 기존(또는 방금 claim된) 학생: 이름이 바뀌었으면 표시용으로 갱신
  if s.name is distinct from v_name then
    update public.students set name = v_name where id = s.id;
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

-- ---------- student_verify (번호 기반, Edge Function 전용) ----------
create or replace function public.student_verify(p_class_id uuid, p_number int, p_pin text)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare s public.students%rowtype;
begin
  select * into s from public.students st
    where st.class_id = p_class_id and st.number = p_number;
  if not found or s.pin_hash is null or p_pin is null
     or s.pin_hash <> public.hash_pin(p_pin, s.pin_salt) then
    return null;
  end if;
  return s.id;
end;
$$;

-- ---------- student_history (번호 기반) ----------
create or replace function public.student_history(p_class_id uuid, p_number int, p_pin text)
returns table (
  id uuid, subject text, unit text, count int, correct int, score int,
  submitted_at timestamptz, detail jsonb
)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_student uuid;
begin
  v_student := public.student_verify(p_class_id, p_number, p_pin);
  if v_student is null then
    raise exception '번호 또는 PIN이 올바르지 않습니다.';
  end if;
  return query
    select s.id, s.subject, s.unit, s.count, s.correct, s.score, s.submitted_at,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'q',     d->'q',
          'type',  d->'type',
          'multi', coalesce(d->'multi', 'false'::jsonb),
          'isCorrect', case when jsonb_typeof(d->'manualOverride') = 'boolean'
                            then d->'manualOverride'
                            else coalesce(d->'isCorrect', 'false'::jsonb) end,
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

-- ---------- 실행 권한 ----------
grant execute on function public.student_enter(uuid, int, text, text)   to anon, authenticated;
grant execute on function public.student_history(uuid, int, text)        to anon, authenticated;
revoke execute on function public.student_verify(uuid, int, text)        from public, anon, authenticated;
grant  execute on function public.student_verify(uuid, int, text)        to service_role;
