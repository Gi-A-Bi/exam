-- ============================================================
-- 정답지 수정 → 기존 응시 재채점
--
-- 배경: 20260705101041 마이그레이션의 trg_answer_keys_edit_guard 는
--       제출된 응시가 있으면 문항/정답 수정을 전부 막고 "복제"를 유도했다.
--       그러나 정답을 잘못 입력한 경우 이미 채점된 점수가 영영 틀린 채로 남는다.
--
-- 결정(사용자 확인):
--   * 문항 수는 제출 이후 변경 불가 — 줄이면 학생이 써낸 답안 기록이 사라진다.
--     정답과 문항 유형(객관식/복수정답/주관식), 선택지 수만 고칠 수 있다.
--   * 정답/유형 변경은 반드시 "재채점과 함께"만 가능하다.
--     정답지만 바꾸고 옛 채점 결과를 그대로 두면 둘이 어긋나기 때문.
--   * 교사의 수동 정정(manualOverride)은 정답이 실제로 바뀐 문항만 초기화하고
--     그대로인 문항은 유지한다. (바뀐 문항의 정정은 옛 정답 기준 판단이므로 무효)
--
-- 채점 자체는 DB에서 다시 하지 않는다. CLAUDE.md §2-1(채점 비트 단위 동일) 때문에
-- 채점 로직을 SQL로 새로 구현하면 안 되고, 교사 화면이 공용 모듈
-- (supabase/functions/_shared/grading.js 와 동일한 코드)로 계산한 detail 을 넘겨받아
-- 저장만 한다. correct/score 는 기존 trg_recompute_submission 트리거가 detail 로부터
-- 다시 계산하므로 집계가 어긋날 여지가 없다.
--
-- 권한: security invoker — RLS 가 그대로 적용되어 본인 정답지/응시만 건드릴 수 있다.
--       교사는 이미 본인 응시 결과를 수동 정정으로 수정할 수 있으므로 권한이 넓어지지 않는다.
-- ============================================================

-- ---------- 1. 수정 가드 완화 ----------
create or replace function public.prevent_answer_key_edit_after_submission()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.submissions where exam_id = old.id) then
    -- 문항 수 변경은 계속 금지 (학생 답안 기록 손실)
    if new.count is distinct from old.count then
      raise exception '이미 제출된 응시가 있어 문항 수는 바꿀 수 없습니다. 복제해서 새 정답지를 만드세요.';
    end if;
    -- 정답/유형/선택지 변경은 재채점 경로에서만 허용 (아래 RPC 가 세션 플래그를 켠다)
    if (new.questions is distinct from old.questions
        or new.choices  is distinct from old.choices)
       and coalesce(current_setting('app.regrade', true), '') <> 'on' then
      raise exception '이미 제출된 응시가 있어 정답만 따로 바꿀 수 없습니다. 재채점과 함께 수정해야 합니다.';
    end if;
  end if;
  return new;
end;
$$;

-- ---------- 2. 정답지 수정 + 재채점 (한 트랜잭션) ----------
-- p_details: [{ "id": "<submission uuid>", "detail": [ ...재채점된 detail... } ]
create or replace function public.update_exam_and_regrade(
  p_exam_id   uuid,
  p_subject   text,
  p_unit      text,
  p_class_id  uuid,
  p_choices   int,
  p_questions jsonb,
  p_details   jsonb
) returns int
language plpgsql
security invoker
as $$
declare
  v_n int := 0;
  r   record;
begin
  -- 트랜잭션 로컬 플래그 — 커밋/롤백과 함께 사라지므로 다른 경로로 새지 않는다.
  perform set_config('app.regrade', 'on', true);

  update public.answer_keys
     set subject   = p_subject,
         unit      = p_unit,
         class_id  = p_class_id,
         choices   = p_choices,
         questions = p_questions
   where id = p_exam_id;          -- RLS: 본인 정답지만
  if not found then
    raise exception '정답지를 찾을 수 없거나 수정 권한이 없습니다.';
  end if;

  for r in
    select (e.value->>'id')::uuid as sid, e.value->'detail' as det
    from jsonb_array_elements(coalesce(p_details, '[]'::jsonb)) e
  loop
    if r.det is null or jsonb_typeof(r.det) <> 'array' then
      raise exception '재채점 결과 형식이 올바르지 않습니다.';
    end if;
    -- correct/score 는 trg_recompute_submission 이 detail 로부터 다시 계산한다.
    update public.submissions
       set detail = r.det
     where id = r.sid
       and exam_id = p_exam_id;   -- RLS: 본인 응시만 + 다른 시험 결과 오염 방지
    if found then v_n := v_n + 1; end if;
  end loop;

  return v_n;
end;
$$;

revoke all on function public.update_exam_and_regrade(uuid, text, text, uuid, int, jsonb, jsonb) from public;
grant execute on function public.update_exam_and_regrade(uuid, text, text, uuid, int, jsonb, jsonb) to authenticated;
