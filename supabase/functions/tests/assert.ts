// 최소 assert 헬퍼 — 외부(jsr/std) 의존 없이 오프라인에서 테스트를 돌리기 위함.
export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
export function assertFalse(cond: unknown, msg = "expected falsy"): void {
  if (cond) throw new Error(msg);
}
export function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error((msg ? msg + " — " : "") + `expected ${e}, got ${a}`);
}
