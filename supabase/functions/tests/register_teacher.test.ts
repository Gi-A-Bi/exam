// 검증: register_teacher 가 코드 중복 / 이메일 중복 등을 올바로 거부하는지.
// (결정 2026-07: 가입코드(joinCode) 검증은 제거됨 — 코드 없이 가입 가능)
import { assert, assertEquals } from "./assert.ts";
import { handleRegister } from "../register_teacher/handler.ts";
import { makeAdmin, type MockDb } from "./mock_admin.ts";

function baseDb(): MockDb {
  return {
    settings: [],
    teachers: [],
    answer_keys: [],
    submissions: [],
    authUsers: [],
  };
}

const VALID = {
  email: "teacher@school.kr",
  password: "secret1",
  name: "김민성",
  code: "KIM01",
};

Deno.test("정상 가입 — 성공 + teachers/authUsers 에 1건씩", async () => {
  const db = baseDb();
  const admin = makeAdmin(db);
  const res: any = await handleRegister({ ...VALID }, admin);
  assert(res.ok, "성공해야 함: " + JSON.stringify(res));
  assertEquals(res.data, { code: "KIM01", name: "김민성" });
  assertEquals(db.teachers.length, 1);
  assertEquals(db.authUsers.length, 1);
});

Deno.test("코드 중복 → 거부 (auth 사용자 생성 전에 차단)", async () => {
  const db = baseDb();
  db.teachers.push({ id: "existing", code: "KIM01", name: "기존교사" });
  const admin = makeAdmin(db);
  const res: any = await handleRegister({ ...VALID }, admin);
  assertEquals(res.ok, false);
  assertEquals(res.error, "이미 사용 중인 코드");
  assertEquals(db.authUsers.length, 0, "중복 코드면 고아 auth 계정이 생기면 안 됨");
});

Deno.test("코드 정규화 후 중복 감지 (소문자/기호 입력)", async () => {
  const db = baseDb();
  db.teachers.push({ id: "existing", code: "KIM01", name: "기존교사" });
  const admin = makeAdmin(db);
  const res: any = await handleRegister({ ...VALID, code: " kim-01! " }, admin);
  // " kim-01! " → 정규화 "KIM-01" 이므로 KIM01 과는 다름 → 이 입력은 중복 아님(성공)
  assert(res.ok, "정규화 결과가 다르면 통과해야 함: " + JSON.stringify(res));
  // 반면 정확히 같은 정규화 결과는 중복
  const res2: any = await handleRegister({ ...VALID, code: "kim01" }, makeAdmin({
    ...baseDb(), teachers: [{ id: "e", code: "KIM01", name: "x" }],
  }));
  assertEquals(res2.ok, false);
  assertEquals(res2.error, "이미 사용 중인 코드");
});

Deno.test("이메일 중복 → createUser 에러를 그대로 거부", async () => {
  const db = baseDb();
  db.authUsers.push({ id: "u-old", email: "teacher@school.kr" });
  const admin = makeAdmin(db);
  const res: any = await handleRegister({ ...VALID }, admin);
  assertEquals(res.ok, false);
  assert(/registered/i.test(res.error), "이메일 중복 메시지여야 함: " + res.error);
  assertEquals(db.teachers.length, 0, "이메일 중복이면 프로필도 안 생겨야 함");
});

Deno.test("비밀번호 6자 미만 → 거부", async () => {
  const admin = makeAdmin(baseDb());
  const res: any = await handleRegister({ ...VALID, password: "12345" }, admin);
  assertEquals(res.ok, false);
  assertEquals(res.error, "비밀번호는 6자 이상");
});

Deno.test("코드 3자 미만(정규화 후) → 거부", async () => {
  const admin = makeAdmin(baseDb());
  const res: any = await handleRegister({ ...VALID, code: "A!" }, admin);
  assertEquals(res.ok, false);
  assertEquals(res.error, "코드는 3자 이상");
});

Deno.test("프로필 insert 실패 → auth 사용자 롤백(삭제)", async () => {
  const db = baseDb();
  db.insertError = { teachers: { message: "insert 실패(테스트)" } };
  const admin = makeAdmin(db);
  const res: any = await handleRegister({ ...VALID }, admin);
  assertEquals(res.ok, false);
  assertEquals(db.authUsers.length, 0, "프로필 insert 실패 시 auth 사용자는 롤백되어야 함");
});
