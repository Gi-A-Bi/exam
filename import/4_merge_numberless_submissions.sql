-- ============================================================
-- 번호 없는 옛 응시 기록을 같은 이름의 '번호 있는 학생'에게 합치기
--
-- 왜 필요한가:
--   2026-07-14 에 학생 식별이 (반, 번호) 로 바뀌었다. 그 전에 쌓인 응시 기록은
--   submissions.number 가 비어 있어서, 화면에서 같은 학생이 "번호 있는 사람"과
--   "이름만 있는 사람" 둘로 쪼개져 보인다.
--   (index.html 의 studentKey = class_id | n<번호> 또는 name:<이름>)
--
-- 무엇을 하는가:
--   같은 반 · 같은 이름의 번호 있는 학생이 **정확히 1명**일 때만
--   그 번호와 student_id 를 옛 기록에 채워 넣는다.
--
-- 안 하는 것 (일부러):
--   * 동명이인이 2명 이상이면 건너뛴다 — 누구 것인지 알 수 없다.
--   * 번호 있는 학생이 없으면 건너뛴다 — 합칠 대상이 없다.
--   * 같은 시험을 그 학생이 이미 제출했으면 건너뛴다 — 중복 제출 방지 유니크
--     인덱스(submissions_exam_student_unique)와 충돌한다.
--   * 점수/정답/detail 은 건드리지 않는다. (재채점 아님)
--
-- 실행 방법: Supabase 대시보드 → SQL Editor 에 **한 단계씩** 붙여넣어 실행.
--            1~2단계로 내용을 확인한 뒤 3단계를 실행하세요.
--
-- ⚠ 3단계는 학생 기록을 실제로 바꿉니다. begin ... commit 으로 감싸 두었으니
--    결과가 이상하면 commit 대신 rollback 을 실행하세요.
-- ============================================================


-- ------------------------------------------------------------
-- 0단계. 대상 반 확인  ← 먼저 이것부터 실행
-- ------------------------------------------------------------
-- 반 이름이 정확히 무엇인지, 내 반이 맞는지 확인합니다.
-- 결과가 2줄 이상이면 아래 모든 쿼리의 반 이름을 더 정확하게 고쳐야 합니다.
select c.id   as class_id,
       c.name as 반이름,
       t.code as 교사코드,
       (select count(*) from public.students    s where s.class_id = c.id) as 학생수,
       (select count(*) from public.submissions b where b.class_id = c.id) as 응시수,
       (select count(*) from public.submissions b where b.class_id = c.id and b.number is null) as 번호없는_응시수
from public.classes c
join public.teachers t on t.id = c.teacher_id
where c.name ilike '%4학년%1반%';


-- ------------------------------------------------------------
-- 1단계. 무엇이 합쳐지는지 미리보기 (아무것도 바꾸지 않음)
-- ------------------------------------------------------------
with target as (
  select id from public.classes where name ilike '%4학년%1반%'
),
numbered as (                       -- 합쳐질 목적지: 번호가 있는 학생
  select s.id as student_id, s.number, s.name
  from public.students s
  where s.class_id in (select id from target) and s.number is not null
),
orphan as (                         -- 합쳐질 대상: 번호 없는 응시 기록
  select b.*
  from public.submissions b
  where b.class_id in (select id from target) and b.number is null
)
select o.name                                                     as 이름,
       count(*)                                                   as 번호없는_응시수,
       (select count(*) from numbered n where n.name = o.name)    as 같은이름_번호학생,
       (select string_agg(distinct n.number::text, ', ')
          from numbered n where n.name = o.name)                  as 후보번호,
       case
         when (select count(*) from numbered n where n.name = o.name) = 1 then '✅ 합쳐짐'
         when (select count(*) from numbered n where n.name = o.name) = 0 then '⏭ 번호 있는 학생 없음 → 그대로 둠'
         else '⚠ 동명이인 → 사람이 판단해야 함'
       end                                                        as 처리,
       min(o.submitted_at)::date                                  as 가장_오래된_응시,
       max(o.submitted_at)::date                                  as 가장_최근_응시
from orphan o
group by o.name
order by 처리, o.name;


-- ------------------------------------------------------------
-- 2단계. 문제가 될 수 있는 경우 점검 (아무것도 바꾸지 않음)
-- ------------------------------------------------------------

-- 2-1. 같은 시험을 '번호 있는 기록'과 '번호 없는 기록'으로 둘 다 낸 경우.
--      합치면 중복이 되므로 3단계가 건너뜁니다. 둘 중 어느 것을 남길지
--      교사 화면(응시 결과 → 행 펼치기 → 🗑 삭제)에서 직접 정리하세요.
with target as (select id from public.classes where name ilike '%4학년%1반%'),
numbered as (
  select s.id as student_id, s.number, s.name
  from public.students s
  where s.class_id in (select id from target) and s.number is not null
),
uniq as (select name, min(number) as number, (array_agg(student_id))[1] as student_id
         from numbered group by name having count(*) = 1)
select o.name as 이름, u.number as 번호, o.subject as 과목, o.unit as 단원,
       o.score as 번호없는_기록_점수, o.submitted_at as 번호없는_기록_제출시각,
       x.score as 기존_기록_점수,      x.submitted_at as 기존_기록_제출시각
from public.submissions o
join uniq u on u.name = o.name
join public.submissions x
  on x.exam_id = o.exam_id and x.student_id = u.student_id and x.id <> o.id
where o.class_id in (select id from target) and o.number is null
order by o.name, o.subject, o.unit;

-- 2-2. 번호 없는 기록끼리 같은 시험이 겹치는 경우(옛 중복 제출).
--      하나만 합치고 나머지는 남으므로 미리 확인하세요.
with target as (select id from public.classes where name ilike '%4학년%1반%')
select name as 이름, exam_id, count(*) as 중복수,
       string_agg(submitted_at::text, ' / ' order by submitted_at) as 제출시각들
from public.submissions
where class_id in (select id from target) and number is null
group by name, exam_id
having count(*) > 1;

-- 2-3. 저장된 점수와 detail 이 어긋난 기록.
--      submissions 를 update 하면 trg_recompute_submission 트리거가
--      detail 로부터 correct/score 를 다시 계산합니다. 보통은 값이 같지만,
--      아래에 행이 나오면 3단계에서 그 점수가 '교정'되어 바뀝니다.
with target as (select id from public.classes where name ilike '%4학년%1반%')
select b.id, b.name as 이름, b.subject as 과목, b.unit as 단원,
       b.score as 저장된_점수,
       case when b.count > 0 then
         round((select count(*) from jsonb_array_elements(b.detail) d
                 where coalesce(case when jsonb_typeof(d->'manualOverride') = 'boolean'
                                     then (d->>'manualOverride')::boolean
                                     else (d->>'isCorrect')::boolean end, false))::numeric
               / b.count * 100)::int
       else 0 end as 다시_계산한_점수
from public.submissions b
where b.class_id in (select id from target) and b.number is null
  and b.score is distinct from (
    case when b.count > 0 then
      round((select count(*) from jsonb_array_elements(b.detail) d
              where coalesce(case when jsonb_typeof(d->'manualOverride') = 'boolean'
                                  then (d->>'manualOverride')::boolean
                                  else (d->>'isCorrect')::boolean end, false))::numeric
            / b.count * 100)::int
    else 0 end);


-- ------------------------------------------------------------
-- 3단계. 실제 병합  ⚠ 여기서부터 데이터가 바뀝니다
-- ------------------------------------------------------------
-- begin 부터 commit 전까지를 한 번에 실행하고, 결과 건수를 확인한 뒤
-- 맞으면 commit, 이상하면 rollback 을 실행하세요.

begin;

with target as (
  select id from public.classes where name ilike '%4학년%1반%'
),
numbered as (
  select s.id as student_id, s.number, s.name
  from public.students s
  where s.class_id in (select id from target) and s.number is not null
),
uniq as (                           -- 이름당 번호 학생이 정확히 1명인 경우만
  -- having count(*) = 1 이라 행이 하나뿐이므로 array_agg[1] 로 그 값을 꺼낸다.
  -- (Postgres 에는 min(uuid) 집계 함수가 없다)
  select name, min(number) as number, (array_agg(student_id))[1] as student_id
  from numbered group by name having count(*) = 1
),
pick as (                           -- 같은 시험 중복은 가장 오래된 1건만 합침
  select distinct on (b.name, b.exam_id) b.id, u.number, u.student_id
  from public.submissions b
  join uniq u on u.name = b.name
  where b.class_id in (select id from target)
    and b.number is null
    and not exists (                -- 그 학생이 이미 낸 같은 시험이 있으면 건너뜀
      select 1 from public.submissions x
      where x.exam_id = b.exam_id and x.student_id = u.student_id and x.id <> b.id
    )
  order by b.name, b.exam_id, b.submitted_at
)
update public.submissions b
   set number     = p.number,
       student_id = p.student_id
  from pick p
 where b.id = p.id;

-- 결과 확인: 남은 '번호 없는 기록' 이 몇 건인지
with target as (select id from public.classes where name ilike '%4학년%1반%')
select count(*) filter (where number is null)     as 아직_번호없음,
       count(*) filter (where number is not null) as 번호있음,
       count(*)                                   as 전체
from public.submissions
where class_id in (select id from target);

-- 맞으면 ↓ 실행, 이상하면 rollback;
commit;


-- ------------------------------------------------------------
-- 4단계(선택). 비어버린 옛 학생 명단 정리
-- ------------------------------------------------------------
-- 3단계로 응시 기록을 옮기고 나면, 번호 없는 옛 학생 행이 남을 수 있습니다.
-- 아무 기록도 참조하지 않는 것만 지웁니다. 먼저 확인:
with target as (select id from public.classes where name ilike '%4학년%1반%')
select s.id, s.name as 이름, s.created_at::date as 생성일,
       (select count(*) from public.submissions b where b.student_id = s.id) as 연결된_응시수
from public.students s
where s.class_id in (select id from target) and s.number is null
order by s.name;

-- 위에서 '연결된_응시수 = 0' 인 행만 지우려면:
-- begin;
-- with target as (select id from public.classes where name ilike '%4학년%1반%')
-- delete from public.students s
--  where s.class_id in (select id from target)
--    and s.number is null
--    and not exists (select 1 from public.submissions b where b.student_id = s.id);
-- commit;
