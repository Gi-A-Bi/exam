-- ============================================================
-- 학생 등록을 '교사 선등록' 방식으로 전환 + 잘못 갈라진 학생 합치기
--
-- 배경(2026-11-18 결정):
--   지금까지는 학생이 입장할 때 번호를 직접 입력하면 그 번호로 **자동 등록**됐다.
--   그래서 같은 학생이 번호를 다르게 입력하면 다른 학생으로 등록되어
--   응시 기록이 둘로 갈라졌다. 오타 한 번이 곧 새 학생이 되는 구조였다.
--
--   앞으로는 교사가 반 관리에서 명단(번호·이름)을 먼저 등록하고,
--   학생은 등록된 번호로만 입장한다. 번호를 잘못 눌러도 새 학생이 생기지 않는다.
--
-- 바뀌는 점:
--   1) student_enter: 등록되지 않은 번호면 거절한다 (자동 등록 없음).
--   2) student_enter: 번호에 등록된 이름과 입력한 이름이 다르면 거절한다.
--      → 번호 오타가 '남의 자리'를 차지하는 사고를 입구에서 막는다.
--   3) merge_students: 이미 갈라진 두 학생 기록을 하나로 합치는 RPC 추가.
--
-- 영향 없음:
--   * 이미 등록된 학생은 그대로 입장된다 (명단에 이미 있으므로).
--   * 번호 없는 옛 학생의 레거시 claim(같은 반·같은 이름·번호없음이 정확히 1명)은
--     기존 기록을 잇기 위해 그대로 둔다.
--   * PIN 방식, 채점, 정답 비노출(§2-2)은 건드리지 않는다.
--
-- ⚠ 새로 만든 반은 교사가 명단을 등록하기 전까지 학생이 입장할 수 없다.
-- ============================================================

-- ---------- 0. 이름 비교용 정규화 ----------
-- 공백 차이·대소문자만 다른 경우를 같은 이름으로 본다. (예: '김 철수' = '김철수')
create or replace function public.normalize_name(p text)
returns text language sql immutable as $$
  select lower(regexp_replace(coalesce(p, ''), '\s+', '', 'g'));
$$;

-- ---------- 1. student_enter: 등록된 번호만 입장 ----------
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
      where st.class_id = p_class_id and st.number is null
        and public.normalize_name(st.name) = public.normalize_name(v_name);
    if v_legacy = 1 then
      update public.students st set number = p_number
        where st.class_id = p_class_id and st.number is null
          and public.normalize_name(st.name) = public.normalize_name(v_name)
        returning st.* into s;
      -- 아래 PIN 검증/설정 로직으로 흐름
    else
      -- 3) 자동 등록하지 않는다 — 교사가 명단에 올린 번호만 입장 가능
      raise exception '등록되지 않은 번호예요. 번호를 다시 확인하고, 그래도 안 되면 선생님께 문의해 주세요.';
    end if;
  else
    -- 번호는 맞는데 이름이 다르면 거절 (번호 오타가 남의 자리를 차지하는 것을 막는다).
    -- 등록된 이름을 되돌려주지 않는다 — 코드만 알면 명단을 캐낼 수 있게 되므로.
    if public.normalize_name(s.name) <> public.normalize_name(v_name) then
      raise exception '번호와 이름이 맞지 않아요. 번호를 다시 확인하고, 그래도 안 되면 선생님께 문의해 주세요.';
    end if;
  end if;

  -- 이름은 교사가 등록한 명단 값을 그대로 둔다.
  -- (예전에는 학생이 입력한 값으로 덮어썼지만, 명단 주인은 교사이고
  --  위에서 이미 정규화 비교로 본인 확인을 마쳤으므로 덮어쓸 이유가 없다.)

  if s.pin_hash is null then
    -- 아직 PIN 이 없음(교사가 막 등록했거나 초기화함) → 지금 입력한 PIN 으로 설정
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

-- ---------- 2. 갈라진 학생 합치기 ----------
-- p_keep 에 p_drop 의 응시 기록을 모두 옮기고 p_drop 을 지운다.
-- 번호만 남고 학생 연결이 없는 옛 기록(student_id is null)도 함께 끌어온다.
-- security invoker — RLS 가 그대로 적용되어 본인 반 학생만 합칠 수 있다.
create or replace function public.merge_students(p_keep uuid, p_drop uuid)
returns int
language plpgsql security invoker as $$
declare
  v_keep public.students%rowtype;
  v_drop public.students%rowtype;
  v_dup  text;
  v_n    int := 0;
begin
  if p_keep is null or p_drop is null then raise exception '학생을 선택해 주세요.'; end if;
  if p_keep = p_drop then raise exception '같은 학생끼리는 합칠 수 없습니다.'; end if;

  select * into v_keep from public.students where id = p_keep;
  if not found then raise exception '남길 학생을 찾을 수 없거나 권한이 없습니다.'; end if;
  select * into v_drop from public.students where id = p_drop;
  if not found then raise exception '합칠 학생을 찾을 수 없거나 권한이 없습니다.'; end if;
  if v_keep.class_id <> v_drop.class_id then
    raise exception '다른 반 학생끼리는 합칠 수 없습니다.';
  end if;

  -- 옮길 대상 = 합칠 학생의 기록 + 그 번호로 남아 있는 '학생 미연결' 옛 기록

  -- 같은 시험을 양쪽이 각각 제출했으면 합칠 수 없다
  -- (submissions_exam_student_unique 위반 + 어느 쪽이 진짜인지 사람이 판단해야 함)
  select string_agg(distinct k.subject || ' · ' || k.unit, ', ') into v_dup
  from public.submissions a
  join public.answer_keys k on k.id = a.exam_id
  where a.student_id = p_keep
    and exists (
      select 1 from public.submissions b
       where b.exam_id = a.exam_id
         and (b.student_id = p_drop
              or (b.student_id is null and b.class_id = v_drop.class_id and b.number = v_drop.number))
    );

  if v_dup is not null then
    raise exception '두 기록이 같은 시험(%)을 각각 제출했어요. 응시 결과에서 남길 쪽만 두고 다른 쪽을 삭제한 뒤 다시 시도해 주세요.', v_dup;
  end if;

  update public.submissions b
     set student_id = p_keep,
         number     = v_keep.number,
         name       = v_keep.name
   where b.student_id = p_drop
      or (b.student_id is null and b.class_id = v_drop.class_id and b.number = v_drop.number);
  get diagnostics v_n = row_count;

  delete from public.students where id = p_drop;
  return v_n;
end;
$$;

revoke all on function public.merge_students(uuid, uuid) from public;
grant execute on function public.merge_students(uuid, uuid) to authenticated;
grant execute on function public.normalize_name(text) to anon, authenticated;
