-- ============================================================
-- 옛 시스템 데이터 이관 2단계 — 실제 테이블로 변환·적재
-- 전제:
--   * 1단계 스테이징 테이블에 CSV 가 들어가 있을 것 (IMPORT.md 참고)
--   * 교사들이 새 시스템에 '옛 시스템과 같은 코드'로 가입되어 있을 것
--     (코드가 다르면 그 교사의 데이터는 제외되고 아래 리포트에 표시됨)
-- 결과: 마지막 SELECT 가 이관/제외 건수 리포트를 보여줌.
-- 점수·정오·수동정정은 옛 값 그대로 보존(재채점하지 않음 — 불변식 2-1).
-- ============================================================

begin;

-- 타임스탬프 안전 변환 (형식이 안 맞으면 now() 로 대체)
create or replace function pg_temp.safe_ts(t text) returns timestamptz
language plpgsql as $$
begin
  return t::timestamptz;
exception when others then
  return now();
end; $$;

create temp table import_report (item text, cnt bigint);
create temp table exam_map (old_id text primary key, new_id uuid);

-- [리포트] 가입 안 된 교사 코드
insert into import_report
select '가입 필요(매칭 안 된 교사코드): ' || coalesce(nullif(trim("teacherCode"),''),'(빈값)'), count(*)
from public.staging_answer_keys s
where not exists (select 1 from public.teachers t where t.code = upper(trim(s."teacherCode")))
group by trim("teacherCode");

-- 1) 정답지 이관 (옛 id → 새 uuid 매핑 저장)
do $$
declare
  r record;
  nid uuid;
begin
  for r in
    select s.*, t.id as tid
    from public.staging_answer_keys s
    join public.teachers t on t.code = upper(trim(s."teacherCode"))
  loop
    insert into public.answer_keys (teacher_id, subject, unit, count, choices, questions, created_at)
    values (
      r.tid,
      coalesce(r.subject, ''),
      coalesce(r.unit, ''),
      coalesce(nullif(trim(r.count), '')::int, jsonb_array_length(r."questionsJson"::jsonb)),
      coalesce(nullif(trim(r.choices), '')::int, 5),
      r."questionsJson"::jsonb,
      pg_temp.safe_ts(r."createdAt")
    )
    returning id into nid;
    insert into exam_map values (trim(r.id), nid);
  end loop;
end $$;

insert into import_report select '이관된 정답지', count(*) from exam_map;

-- 2) 응시 결과 이관 (detail 의 정오/수동정정/검토표시 그대로 보존)
with ins as (
  insert into public.submissions
    (teacher_id, exam_id, name, subject, unit, count, correct, score, detail, submitted_at)
  select
    t.id, m.new_id,
    coalesce(trim(s.name), ''),
    coalesce(s.subject, ''), coalesce(s.unit, ''),
    coalesce(nullif(trim(s.count), '')::int, 0),
    coalesce(nullif(trim(s.correct), '')::int, 0),
    coalesce(nullif(trim(s.score), '')::int, 0),
    s."detailJson"::jsonb,
    pg_temp.safe_ts(s."submittedAt")
  from public.staging_submissions s
  join public.teachers t on t.code = upper(trim(s."teacherCode"))
  join exam_map m on m.old_id = trim(s."examId")
  returning 1
)
insert into import_report select '이관된 응시 결과', count(*) from ins;

-- [리포트] 제외된 응시 결과 (교사 미가입 또는 옛 시험 id 를 찾지 못함)
insert into import_report
select '제외된 응시 결과(교사 미가입/옛 시험 없음)', count(*)
from public.staging_submissions s
where not exists (
  select 1 from public.teachers t
  join exam_map m on m.old_id = trim(s."examId")
  where t.code = upper(trim(s."teacherCode"))
);

commit;

-- 이관 결과 리포트
select * from import_report order by item;
