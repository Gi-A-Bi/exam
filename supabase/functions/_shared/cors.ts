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
