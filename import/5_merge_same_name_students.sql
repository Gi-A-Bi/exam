-- ============================================================
-- 같은 반에서 '이름이 같은 학생'을 하나로 합치기 (일괄)
--
-- 언제 쓰나:
--   학생이 입장할 때 번호를 다르게 입력해 같은 사람이 여러 번호로 등록된 경우.
--   묶음이 몇 개 안 되면 화면에서 하는 편이 안전합니다:
--     반 관리 → 반 이름 클릭 → [이 번호로 합치기]
--   묶음이 많아 한 번에 처리하고 싶을 때 이 스크립트를 쓰세요.
--
-- 먼저 할 일:
--   * setup_update_20261118.sql 이 적용돼 있어야 합니다 (merge_students 함수 필요).
--   * 번호 없이 이름만 있는 '옛 응시 기록'은 이 스크립트가 다루지 않습니다.
--     그건 4_merge_numberless_submissions.sql 로 **먼저** 처리하세요.
--
-- ⚠ 동명이인이 있으면 이 스크립트가 서로 다른 사람을 합쳐버립니다.
--    2단계 미리보기를 반드시 눈으로 확인하고 3단계를 실행하세요.
--    동명이인이 섞여 있으면 3단계를 쓰지 말고 화면에서 하나씩 처리하세요.
--
-- 실행 방법: Supabase 대시보드 → SQL Editor 에 한 단계씩 붙여넣어 실행.
-- ============================================================


-- ------------------------------------------------------------
-- 1단계. 대상 반 확인  ← 먼저 이것부터
-- ------------------------------------------------------------
select c.id as class_id, c.name as 반이름, t.code as 교사코드,
       (select count(*) from public.students s where s.class_id = c.id) as 학생수
from public.classes c
join public.teachers t on t.id = c.teacher_id
where c.name ilike '%4학년%1반%';


-- ------------------------------------------------------------
-- 2단계. 합쳐질 묶음 미리보기 (아무것도 바꾸지 않음)  ⚠ 꼭 확인
-- ------------------------------------------------------------
-- '남길번호' 기준: 응시 기록이 가장 많은 번호, 같으면 가장 작은 번호.
-- 이 기준이 마음에 안 들면 3단계 대신 화면에서 원하는 번호를 골라 합치세요.
with target as (
  select id from public.classes where name ilike '%4학년%1반%'
),
cnt as (                                   -- 학생별 응시 건수(학생 연결 + 번호 기준 옛 기록)
  select s.id, s.class_id, s.number, s.name,
         (select count(*) from public.submissions b where b.student_id = s.id)
       + (select count(*) from public.submissions b
           where b.student_id is null and b.class_id = s.class_id and b.number = s.number) as n
  from public.students s
  where s.class_id in (select id from target)
),
grp as (
  select public.normalize_name(name) as key, count(*) as 번호수
  from cnt group by public.normalize_name(name) having count(*) > 1
)
select c.name as 이름,
       c.number as 번호,
       c.n as 응시건수,
       case when c.id = (
         select c2.id from cnt c2
         where public.normalize_name(c2.name) = public.normalize_name(c.name)
         order by c2.n desc, c2.number asc nulls last limit 1
       ) then '✅ 남길 번호' else '→ 여기로 합쳐짐' end as 처리
from cnt c
join grp g on g.key = public.normalize_name(c.name)
order by c.name, c.number nulls last;


-- ------------------------------------------------------------
-- 3단계. 일괄 합치기  ⚠ 2단계를 확인한 뒤에만 실행
-- ------------------------------------------------------------
-- merge_students 가 반 일치·중복 제출을 다시 한 번 검사하므로,
-- 합칠 수 없는 묶음은 통째로 실패하고 아무것도 바뀌지 않습니다(롤백).
-- 그 경우 메시지에 나온 시험을 응시 결과에서 정리한 뒤 다시 실행하세요.

begin;

do $$
declare
  v_class  uuid;
  g        record;      -- 같은 이름 묶음
  d        record;      -- 합쳐질(사라질) 학생
  v_keep   uuid;
  v_moved  int;
  v_total  int := 0;
  v_groups int := 0;
begin
  select id into v_class from public.classes where name ilike '%4학년%1반%';
  if v_class is null then raise exception '반을 찾지 못했습니다. 1단계로 반 이름을 확인하세요.'; end if;

  for g in
    select public.normalize_name(s.name) as key
    from public.students s
    where s.class_id = v_class
    group by public.normalize_name(s.name)
    having count(*) > 1
  loop
    -- 남길 학생: 응시 많은 번호 → 같으면 작은 번호
    select s.id into v_keep
    from public.students s
    where s.class_id = v_class and public.normalize_name(s.name) = g.key
    order by (
      (select count(*) from public.submissions b where b.student_id = s.id)
    + (select count(*) from public.submissions b
        where b.student_id is null and b.class_id = s.class_id and b.number = s.number)
    ) desc, s.number asc nulls last
    limit 1;

    v_groups := v_groups + 1;

    for d in
      select s.id from public.students s
      where s.class_id = v_class
        and public.normalize_name(s.name) = g.key
        and s.id <> v_keep
    loop
      v_moved := public.merge_students(v_keep, d.id);
      v_total := v_total + coalesce(v_moved, 0);
    end loop;
  end loop;

  raise notice '묶음 % 개를 합쳤고, 응시 기록 % 건을 옮겼습니다.', v_groups, v_total;
end $$;

-- 결과 확인: 남은 같은-이름 묶음이 없어야 합니다
with target as (select id from public.classes where name ilike '%4학년%1반%')
select public.normalize_name(name) as 이름키, count(*) as 남은_번호수
from public.students
where class_id in (select id from target)
group by public.normalize_name(name)
having count(*) > 1;

-- 맞으면 ↓ 실행, 이상하면 rollback;
commit;
