// 검증: withCors 가 OPTIONS 프리플라이트를 처리하고 모든 응답에 CORS 헤더를 붙이는지.
import { assert, assertEquals } from "./assert.ts";
import { withCors, corsHeaders } from "../_shared/cors.ts";

Deno.test("OPTIONS 프리플라이트 → CORS 헤더 응답 (handler 미실행)", async () => {
  let called = false;
  const fn = withCors(async () => { called = true; return { ok: true }; });
  const res = await fn(new Request("https://x/func", { method: "OPTIONS" }));
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert(res.headers.get("Access-Control-Allow-Headers")!.includes("authorization"));
  assert(res.headers.get("Access-Control-Allow-Methods")!.includes("POST"));
  assertEquals(called, false, "OPTIONS 에서는 handler 를 실행하면 안 됨");
});

Deno.test("정상 POST 응답에도 CORS 헤더 + JSON", async () => {
  const fn = withCors(async () => ({ ok: true, data: { hi: 1 } }));
  const res = await fn(new Request("https://x/func", { method: "POST" }));
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(res.headers.get("Content-Type"), "application/json");
  assertEquals(await res.json(), { ok: true, data: { hi: 1 } });
});

Deno.test("handler 예외 → ok:false + CORS 헤더 유지", async () => {
  const fn = withCors(async () => { throw new Error("boom"); });
  const res = await fn(new Request("https://x/func", { method: "POST" }));
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  const body = await res.json();
  assertEquals(body.ok, false);
  assert(/boom/.test(body.error));
});

Deno.test("corsHeaders 는 필요한 3개 키를 모두 포함", () => {
  assert("Access-Control-Allow-Origin" in corsHeaders);
  assert("Access-Control-Allow-Headers" in corsHeaders);
  assert("Access-Control-Allow-Methods" in corsHeaders);
});
