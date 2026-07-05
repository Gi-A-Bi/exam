// register_teacher Edge Function — HTTP 진입점 (계약: edge-functions-contract.md §1)
// 로직은 handler.ts(handleRegister)에 있고, 여기서는 admin 클라이언트 생성 + req/res 연결만.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleRegister } from "./handler.ts";
import { withCors } from "../_shared/cors.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,   // 서버 전용
);

Deno.serve(withCors(async (req) => {
  const body = await req.json();
  return handleRegister(body, admin);
}));
