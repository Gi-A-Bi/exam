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
