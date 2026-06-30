// register_teacher Edge Function — HTTP 진입점 (계약: edge-functions-contract.md §1)
// 로직은 handler.ts(handleRegister)에 있고, 여기서는 admin 클라이언트 생성 + req/res 연결만.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleRegister } from "./handler.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,   // 서버 전용
);

const json = (o: unknown) =>
  new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    return json(await handleRegister(body, admin));
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) });
  }
});
