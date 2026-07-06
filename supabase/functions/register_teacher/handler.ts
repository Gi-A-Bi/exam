// register_teacher — 핵심 로직 (테스트 가능하도록 admin 클라이언트를 주입받는 형태)
// 계약: edge-functions-contract.md §1
// 결정(2026-07): 학교 가입코드(joinCode) 검증 제거 — 코드 없이 누구나 가입 가능.

export const normalizeCode = (s: string) =>
  (s ?? "").trim().toUpperCase().replace(/[^A-Z0-9\-_]/g, "");

export interface RegisterInput {
  email?: string;
  password?: string;
  name?: string;
  code?: string;
}

// admin: supabase service_role 클라이언트 (또는 동일 인터페이스의 테스트 더블)
export async function handleRegister(input: RegisterInput, admin: any) {
  const { email, password, name, code } = input ?? {};

  // 1. 입력 검증
  if (!name || !email || !password) return { ok: false, error: "필수 항목 누락" };
  if (password.length < 6)          return { ok: false, error: "비밀번호는 6자 이상" };

  // 2. 코드 정규화·길이
  const ncode = normalizeCode(code ?? "");
  if (ncode.length < 3)             return { ok: false, error: "코드는 3자 이상" };

  // 3. 코드 중복 확인 (auth 사용자 생성 전 → 고아 계정 방지)
  const { data: dup } = await admin.from("teachers")
    .select("code").eq("code", ncode).maybeSingle();
  if (dup)                          return { ok: false, error: "이미 사용 중인 코드" };

  // 4. Auth 사용자 생성 (email_confirm: true — 계약 §결정에 따라 가입 즉시 확정)
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (cErr) return { ok: false, error: cErr.message };   // 이메일 중복 등

  // 5. 프로필 insert. 실패 시 4에서 만든 auth 사용자 삭제(롤백).
  const { error: pErr } = await admin.from("teachers")
    .insert({ id: created.user.id, code: ncode, name: name.trim() });
  if (pErr) {
    await admin.auth.admin.deleteUser(created.user.id);  // 롤백
    return { ok: false, error: pErr.message };
  }

  // 6. 성공
  return { ok: true, data: { code: ncode, name: name.trim() } };
}
