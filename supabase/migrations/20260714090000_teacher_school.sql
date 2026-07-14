-- ============================================================
-- 교사별 학교명 (결정 2026-07-14)
--
-- 가입코드 폐지로 주소만 알면 어느 학교 선생님이든 가입할 수 있게 되어,
-- 학생·교사 화면에서 "어느 학교의 누구"인지 구분할 수단이 필요해짐.
--  * 가입 시 학교 이름을 입력받아 teachers.school 에 저장 (프론트 필수,
--    서버는 구버전 프론트 호환을 위해 선택 — 없으면 null)
--  * 학생이 선생님 코드를 입력하면 "○○학교 ○○ 선생님"으로 확인시켜
--    코드 오입력·동명이인 혼동을 줄임
--  * 기존 계정(school null)은 교사 화면의 [학교명 설정]으로 채움
--    (RLS "teacher updates own profile" 이 이미 본인 행 update 허용)
-- ============================================================

alter table public.teachers add column if not exists school text;

-- get_teacher_public 에 school 포함 (반환 타입 변경이므로 drop 후 재생성)
drop function if exists public.get_teacher_public(text);
create or replace function public.get_teacher_public(p_code text)
returns table (code text, name text, school text)
language sql security definer set search_path = public as $$
  select t.code, t.name, t.school
  from public.teachers t
  where t.code = public.normalize_code(p_code);
$$;
grant execute on function public.get_teacher_public(text) to anon, authenticated;
