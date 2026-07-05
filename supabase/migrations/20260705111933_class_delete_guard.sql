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
