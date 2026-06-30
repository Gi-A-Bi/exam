-- ============================================================
-- 시드 데이터 — settings 초기값
-- `supabase db reset` 시 마이그레이션 적용 후 실행됨.
-- joinCode는 학생에게 노출되지 않는 값(불변식 2-2): RPC로 절대 반환하지 않음.
-- 운영 배포 시 실제 값으로 교체할 것.
-- ============================================================

insert into public.settings (key, value) values
  ('schoolName', '서울예술중학교'),
  ('joinCode',   'CHANGE-ME-1234')
on conflict (key) do nothing;
