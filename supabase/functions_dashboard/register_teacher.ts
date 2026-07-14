// register_teacher — 대시보드 배포용 단일 파일 번들 (자동 생성)
// 원본: supabase/functions/register_teacher/{index,handler}.ts + _shared/cors.ts
// 내용은 원본과 동일하며, 수정은 원본에서 하고 이 파일은 재생성할 것.
import { createClient } from "jsr:@supabase/supabase-js@2";

// ===== _shared/cors.ts =====
// 공용 CORS 처리 — 정적 프론트엔드(다른 출처)에서 supabase-js functions.invoke 로
// 호출하므로 브라우저 프리플라이트(OPTIONS)와 응답 CORS 헤더가 반드시 필요.
// (.rpc/.from/auth 는 Supabase 가 CORS 를 기본 제공하지만 Edge Function 은 수동 처리.)

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// JSON 응답에 CORS 헤더를 함께 실어 반환.
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Deno.serve 핸들러를 감싸: OPTIONS 프리플라이트는 즉시 응답,
// 그 외에는 handler 실행 후 JSON+CORS 로 감싼다. handler 예외는 { ok:false } 로 변환.
export function withCors(
  handler: (req: Request) => Promise<unknown>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    try {
      return jsonResponse(await handler(req));
    } catch (e) {
      return jsonResponse({ ok: false, error: String((e as Error).message ?? e) });
    }
  };
}

// ===== register_teacher/handler.ts =====
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
  school?: string;
}

// admin: supabase service_role 클라이언트 (또는 동일 인터페이스의 테스트 더블)
export async function handleRegister(input: RegisterInput, admin: any) {
  const { email, password, name, code, school } = input ?? {};

  // 1. 입력 검증
  if (!name || !email || !password) return { ok: false, error: "필수 항목 누락" };
  if (password.length < 6)          return { ok: false, error: "비밀번호는 6자 이상" };

  // 학교명: 프론트는 필수로 받지만 서버는 선택 처리(마이그레이션 전 구버전 프론트 호환).
  // 없으면 null 저장 → 교사 화면의 [학교명 설정]으로 나중에 채울 수 있음.
  const nschool = String(school ?? "").trim().slice(0, 40) || null;

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
    .insert({ id: created.user.id, code: ncode, name: name.trim(), school: nschool });
  if (pErr) {
    await admin.auth.admin.deleteUser(created.user.id);  // 롤백
    return { ok: false, error: pErr.message };
  }

  // 6. 성공
  return { ok: true, data: { code: ncode, name: name.trim(), school: nschool } };
}

// ===== register_teacher/index.ts (진입점) =====
// register_teacher Edge Function — HTTP 진입점 (계약: edge-functions-contract.md §1)
// 로직은 handler.ts(handleRegister)에 있고, 여기서는 admin 클라이언트 생성 + req/res 연결만.

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,   // 서버 전용
);

Deno.serve(withCors(async (req) => {
  const body = await req.json();
  return handleRegister(body, admin);
}));
