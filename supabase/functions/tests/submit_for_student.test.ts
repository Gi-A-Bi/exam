// 검증: submit_for_student (v2: 반+PIN)
//  - 응답의 문항별 객체에 correct/student/manualOverride 가 없는지 (불변식 2-2)
//  - PIN 검증 / 반별 시험 분리 / 제출 불변성(재제출 거부)
import { assert, assertEquals, assertFalse } from "./assert.ts";
import { handleSubmit } from "../submit_for_student/handler.ts";
import { makeAdmin, makeStudentVerify, type MockDb } from "./mock_admin.ts";

function baseDb(): MockDb {
  const db: MockDb = {
    settings: [],
    teachers: [{ id: "t1", code: "KIM01", name: "김민성" }],
    classes: [
      { id: "class-1", teacher_id: "t1", name: "2026 3반" },
      { id: "class-2", teacher_id: "t1", name: "2026 4반" },
    ],
    students: [
      { id: "stu-1", class_id: "class-1", name: "홍길동", number: 3, pin: "1234" },
      { id: "stu-2", class_id: "class-2", name: "홍길동", number: 3, pin: "9999" }, // 다른 반 동명이인
    ],
    answer_keys: [{
      id: "exam-1",
      teacher_id: "t1",
      subject: "수학",
      unit: "3단원",
      count: 3,
      choices: 5,
      class_id: null,                                        // 모든 반 공통
      questions: [
        { q: 1, type: "mc", answer: 3 },                       // 단일
        { q: 2, type: "mc", multi: true, answers: [1, 3] },    // 복수
        { q: 3, type: "short", answers: ["서울", "서울특별시"] }, // 주관식
      ],
    }, {
      id: "exam-2",
      teacher_id: "t1",
      subject: "수학",
      unit: "4반전용",
      count: 1,
      choices: 5,
      class_id: "class-2",                                   // 4반 전용
      questions: [{ q: 1, type: "mc", answer: 2 }],
    }],
    submissions: [],
    authUsers: [],
  };
  db.rpcHandlers = { student_verify: makeStudentVerify(db) };
  return db;
}

const VALID = {
  examId: "exam-1", classId: "class-1", number: 3, name: "홍길동", pin: "1234",
  answers: [
    { q: 1, answer: 3 },
    { q: 2, answer: [3, 1] },
    { q: 3, answer: "서울시" },   // 오답이지만 유사 → needsReview 기대
  ],
};

const STUDENT_ALLOWED = ["q", "type", "multi", "isCorrect", "needsReview"];
const FORBIDDEN = ["correct", "student", "manualOverride"];

Deno.test("응답 detail 의 모든 문항에 correct/student/manualOverride 가 없다", async () => {
  const db = baseDb();
  const res: any = await handleSubmit({ ...VALID }, makeAdmin(db));
  assert(res.ok, "성공 응답이어야 함: " + JSON.stringify(res));
  assertEquals(res.data.detail.length, 3);
  for (const d of res.data.detail) {
    for (const f of FORBIDDEN) {
      assertFalse(f in d, `금지 필드 '${f}' 가 학생 응답에 노출됨: ${JSON.stringify(d)}`);
    }
    assertEquals(Object.keys(d).sort(), [...STUDENT_ALLOWED].sort(),
      `허용 외 필드 존재: ${JSON.stringify(d)}`);
  }
});

Deno.test("정답은 응답 어디에도 없지만 DB(submissions)에는 전체 detail + 반/학생ID 저장", async () => {
  const db = baseDb();
  const res: any = await handleSubmit({
    ...VALID, answers: [{ q: 1, answer: 3 }, { q: 2, answer: [1, 3] }, { q: 3, answer: "서울" }],
  }, makeAdmin(db));
  const blob = JSON.stringify(res.data);
  assertFalse(blob.includes("서울특별시"), "정답 후보가 응답에 노출됨");
  assertEquals(db.submissions.length, 1);
  const saved = db.submissions[0];
  assert("correct" in saved.detail[0], "DB detail 에는 문항별 correct 가 있어야 함");
  assert("manualOverride" in saved.detail[0]);
  assert("student" in saved.detail[0]);
  assertEquals(saved.class_id, "class-1");
  assertEquals(saved.student_id, "stu-1");
});

Deno.test("PIN 불일치/미입력 → 거부 (채점·저장 안 함)", async () => {
  const db = baseDb();
  const admin = makeAdmin(db);
  const bad: any = await handleSubmit({ ...VALID, pin: "0000" }, admin);
  assertEquals(bad.ok, false);
  assert(/PIN/.test(bad.error), "PIN 오류 안내: " + bad.error);
  const missing: any = await handleSubmit({ ...VALID, pin: undefined }, admin);
  assertEquals(missing.ok, false);
  assertEquals(db.submissions.length, 0);
});

Deno.test("다른 반 전용 시험은 응시 불가 / 자기 반 전용은 가능", async () => {
  const db = baseDb();
  const admin = makeAdmin(db);
  // 3반 학생이 4반 전용 시험(exam-2) → 거부
  const cross: any = await handleSubmit({
    ...VALID, examId: "exam-2", answers: [{ q: 1, answer: 2 }],
  }, admin);
  assertEquals(cross.ok, false);
  assert(/이 반에서 응시할 수 없는/.test(cross.error), cross.error);
  // 4반 학생(동명이인, 다른 PIN)이 4반 전용 시험 → 성공
  const own: any = await handleSubmit({
    examId: "exam-2", classId: "class-2", number: 3, name: "홍길동", pin: "9999",
    answers: [{ q: 1, answer: 2 }],
  }, admin);
  assert(own.ok, "자기 반 전용 시험은 응시 가능: " + JSON.stringify(own));
});

Deno.test("같은 학생 재제출 → 거부 / 다른 반 동명이인은 같은 공통시험 제출 가능", async () => {
  const db = baseDb();
  const admin = makeAdmin(db);
  const first: any = await handleSubmit({ ...VALID }, admin);
  assert(first.ok);
  // 같은 학생(공백 섞인 이름도 trim 후 동일) → 거부
  const second: any = await handleSubmit({ ...VALID, name: "  홍길동  " }, admin);
  assertEquals(second.ok, false);
  assert(/이미 제출/.test(second.error), second.error);
  assertEquals(db.submissions.length, 1, "재제출이 저장되면 안 됨");
  // 다른 반 동명이인 → 같은 공통 시험 제출 가능 (이름 기반이었으면 막혔을 케이스)
  const twin: any = await handleSubmit({
    examId: "exam-1", classId: "class-2", number: 3, name: "홍길동", pin: "9999",
    answers: [{ q: 1, answer: 3 }],
  }, admin);
  assert(twin.ok, "다른 반 동명이인은 제출 가능해야 함: " + JSON.stringify(twin));
  assertEquals(db.submissions.length, 2);
});

Deno.test("없는 반/시험 → 거부", async () => {
  const admin = makeAdmin(baseDb());
  const r1: any = await handleSubmit({ ...VALID, classId: "no-class" }, admin);
  assertEquals(r1.ok, false);
  const r2: any = await handleSubmit({ ...VALID, examId: "no-exam" }, admin);
  assertEquals(r2.ok, false);
});

Deno.test("이름 공백/과대입력 하드닝 → 거부", async () => {
  const admin = makeAdmin(baseDb());
  const r1: any = await handleSubmit({ ...VALID, name: "   " }, admin);
  assertEquals(r1.ok, false);
  const r2: any = await handleSubmit({ ...VALID, name: "가".repeat(51) }, admin);
  assertEquals(r2.ok, false);
  const r3: any = await handleSubmit({
    ...VALID, answers: Array.from({ length: 501 }, (_, i) => ({ q: i, answer: 1 })),
  }, admin);
  assertEquals(r3.ok, false);
});

Deno.test("insert 시 unique 위반(동시 재제출 레이스) → 같은 재제출 안내로 매핑", async () => {
  const db = baseDb();
  db.insertError = { submissions: { message: 'duplicate key value violates unique constraint "submissions_exam_student_unique"' } };
  const res: any = await handleSubmit({ ...VALID }, makeAdmin(db));
  assertEquals(res.ok, false);
  assert(/이미 제출/.test(res.error), res.error);
});

Deno.test("submissions insert 실패 → ok:false (유실을 성공으로 위장하지 않음)", async () => {
  const db = baseDb();
  db.insertError = { submissions: { message: "insert 실패(테스트)" } };
  const res: any = await handleSubmit({ ...VALID }, makeAdmin(db));
  assertEquals(res.ok, false, "insert 실패 시 성공 응답을 주면 안 됨");
  assertEquals(db.submissions.length, 0);
});

Deno.test("최상위 correct(맞은 개수)/score 는 정상 노출된다", async () => {
  const res: any = await handleSubmit({
    ...VALID, answers: [{ q: 1, answer: 3 }, { q: 2, answer: [1, 3] }, { q: 3, answer: "서울" }],
  }, makeAdmin(baseDb()));
  assertEquals(res.data.count, 3);
  assertEquals(res.data.correct, 3);
  assertEquals(res.data.score, 100);
});
