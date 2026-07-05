// 검증: submit_for_student 응답의 문항별 객체에
// correct / student / manualOverride 가 '들어있지 않은지' (불변식 2-2, 정답 비노출).
import { assert, assertEquals, assertFalse } from "./assert.ts";
import { handleSubmit } from "../submit_for_student/handler.ts";
import { makeAdmin, type MockDb } from "./mock_admin.ts";

function baseDb(): MockDb {
  return {
    settings: [],
    teachers: [{ id: "t1", code: "KIM01", name: "김민성" }],
    answer_keys: [{
      id: "exam-1",
      teacher_id: "t1",
      subject: "수학",
      unit: "3단원",
      count: 3,
      choices: 5,
      questions: [
        { q: 1, type: "mc", answer: 3 },                       // 단일
        { q: 2, type: "mc", multi: true, answers: [1, 3] },    // 복수
        { q: 3, type: "short", answers: ["서울", "서울특별시"] }, // 주관식
      ],
    }],
    submissions: [],
    authUsers: [],
  };
}

const STUDENT_ALLOWED = ["q", "type", "multi", "isCorrect", "needsReview"];
const FORBIDDEN = ["correct", "student", "manualOverride"];

Deno.test("응답 detail 의 모든 문항에 correct/student/manualOverride 가 없다", async () => {
  const db = baseDb();
  const admin = makeAdmin(db);
  const res: any = await handleSubmit({
    teacherCode: "kim01", // 소문자 → 정규화 확인
    examId: "exam-1",
    name: "홍길동",
    answers: [
      { q: 1, answer: 3 },          // 정답
      { q: 2, answer: [3, 1] },     // 복수 정답(순서 무관)
      { q: 3, answer: "서울시" },    // 오답이지만 유사 → needsReview 기대
    ],
  }, admin);

  assert(res.ok, "성공 응답이어야 함");
  assertEquals(res.data.detail.length, 3);

  for (const d of res.data.detail) {
    for (const f of FORBIDDEN) {
      assertFalse(f in d, `금지 필드 '${f}' 가 학생 응답에 노출됨: ${JSON.stringify(d)}`);
    }
    // 허용 필드만 정확히 존재하는지(키 집합 동일)
    assertEquals(Object.keys(d).sort(), [...STUDENT_ALLOWED].sort(),
      `허용 외 필드 존재: ${JSON.stringify(d)}`);
  }
});

Deno.test("정답은 응답 어디에도 없지만 DB(submissions)에는 전체 detail 이 저장된다", async () => {
  const db = baseDb();
  const admin = makeAdmin(db);
  const res: any = await handleSubmit({
    teacherCode: "KIM01",
    examId: "exam-1",
    name: "홍길동",
    answers: [{ q: 1, answer: 3 }, { q: 2, answer: [1, 3] }, { q: 3, answer: "서울" }],
  }, admin);

  // 응답 직렬화 전체에 정답 텍스트가 새어나오지 않아야 함
  const blob = JSON.stringify(res.data);
  assertFalse(blob.includes("서울특별시"), "정답 후보가 응답에 노출됨");
  assertFalse(blob.includes('"correct"') === false ? false : blob.includes('"manualOverride"'),
    "manualOverride 누출");

  // 그러나 DB 에는 교사용 전체 detail(정답 포함)이 저장돼야 함
  assertEquals(db.submissions.length, 1);
  const saved = db.submissions[0];
  assert("correct" in saved.detail[0], "DB detail 에는 문항별 correct 가 있어야 함");
  assert("manualOverride" in saved.detail[0], "DB detail 에는 manualOverride 가 있어야 함");
  assert("student" in saved.detail[0], "DB detail 에는 student 가 있어야 함");
});

Deno.test("최상위 correct(맞은 개수)/score 는 정상 노출된다", async () => {
  const db = baseDb();
  const admin = makeAdmin(db);
  const res: any = await handleSubmit({
    teacherCode: "KIM01",
    examId: "exam-1",
    name: "홍길동",
    answers: [{ q: 1, answer: 3 }, { q: 2, answer: [1, 3] }, { q: 3, answer: "서울" }],
  }, admin);
  assertEquals(res.data.count, 3);
  assertEquals(res.data.correct, 3);   // 3문제 모두 정답
  assertEquals(res.data.score, 100);
});

Deno.test("없는 시험/선생님 코드는 거부", async () => {
  const admin = makeAdmin(baseDb());
  const r1: any = await handleSubmit({ teacherCode: "NOPE", examId: "exam-1", name: "x", answers: [] }, admin);
  assertEquals(r1.ok, false);
  const r2: any = await handleSubmit({ teacherCode: "KIM01", examId: "no-exam", name: "x", answers: [] }, admin);
  assertEquals(r2.ok, false);
});

Deno.test("같은 시험에 같은 이름 재제출 → 거부 (제출 불변성)", async () => {
  const db = baseDb();
  const admin = makeAdmin(db);
  const payload = {
    teacherCode: "KIM01", examId: "exam-1", name: "홍길동",
    answers: [{ q: 1, answer: 3 }],
  };
  const first: any = await handleSubmit({ ...payload }, admin);
  assert(first.ok, "첫 제출은 성공해야 함");
  assertEquals(db.submissions.length, 1);

  // 같은 이름(공백 섞어도 trim 후 동일) → 거부, 저장 안 됨
  const second: any = await handleSubmit({ ...payload, name: "  홍길동  " }, admin);
  assertEquals(second.ok, false);
  assert(/이미 제출/.test(second.error), "재제출 안내 메시지: " + second.error);
  assertEquals(db.submissions.length, 1, "재제출이 저장되면 안 됨");

  // 다른 이름은 정상 제출
  const other: any = await handleSubmit({ ...payload, name: "김철수" }, admin);
  assert(other.ok, "다른 학생은 제출 가능해야 함");
  assertEquals(db.submissions.length, 2);
});

Deno.test("이름 공백/과대입력 하드닝 → 거부", async () => {
  const admin = makeAdmin(baseDb());
  const r1: any = await handleSubmit({ teacherCode: "KIM01", examId: "exam-1", name: "   ", answers: [] }, admin);
  assertEquals(r1.ok, false);
  const r2: any = await handleSubmit({ teacherCode: "KIM01", examId: "exam-1", name: "가".repeat(51), answers: [] }, admin);
  assertEquals(r2.ok, false);
  const r3: any = await handleSubmit({
    teacherCode: "KIM01", examId: "exam-1", name: "홍길동",
    answers: Array.from({ length: 501 }, (_, i) => ({ q: i, answer: 1 })),
  }, admin);
  assertEquals(r3.ok, false);
});

Deno.test("insert 시 unique 위반(동시 재제출 레이스) → 같은 재제출 안내로 매핑", async () => {
  const db = baseDb();
  db.insertError = { submissions: { message: 'duplicate key value violates unique constraint "submissions_exam_name_unique"' } };
  const admin = makeAdmin(db);
  const res: any = await handleSubmit({
    teacherCode: "KIM01", examId: "exam-1", name: "홍길동",
    answers: [{ q: 1, answer: 3 }],
  }, admin);
  assertEquals(res.ok, false);
  assert(/이미 제출/.test(res.error), "unique 위반은 재제출 안내로 매핑: " + res.error);
});

Deno.test("submissions insert 실패 → ok:false (유실을 성공으로 위장하지 않음)", async () => {
  const db = baseDb();
  db.insertError = { submissions: { message: "insert 실패(테스트)" } };
  const admin = makeAdmin(db);
  const res: any = await handleSubmit({
    teacherCode: "KIM01",
    examId: "exam-1",
    name: "홍길동",
    answers: [{ q: 1, answer: 3 }, { q: 2, answer: [1, 3] }, { q: 3, answer: "서울" }],
  }, admin);
  assertEquals(res.ok, false, "insert 실패 시 성공 응답을 주면 안 됨");
  assertEquals(db.submissions.length, 0);
});
