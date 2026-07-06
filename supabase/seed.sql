-- ============================================================
-- 시드 데이터 — settings 초기값
-- `supabase db reset` 시 마이그레이션 적용 후 실행됨.
-- 운영 배포 시 실제 값으로 교체할 것. (가입코드 joinCode 는 폐지됨)
-- ============================================================

insert into public.settings (key, value) values
  ('schoolName', '서울예술중학교')
on conflict (key) do nothing;
