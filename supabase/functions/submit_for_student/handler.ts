// submit_for_student — 핵심 로직 (테스트 가능하도록 admin 클라이언트를 주입받는 형태)
// 계약: edge-functions-contract.md §2
// 채점은 grading.js의 gradeSubmission_ 를 그대로 사용 (재구현 금지, 불변식 2-1).
// 응답에서 문항별 정답(correct)·student·manualOverride 를 제거 (불변식 2-2).
import { gradeSubmission_ } from "../_shared/grading.js";

export const normalizeCode = (s: string) =>
  (s ?? "").trim().toUpperCase().replace(/[^A-Z0-9\-_]/g, "");

export interface SubmitInput {
  teacherCode?: string;
  examId?: string;
  name?: string;
  answers?: Array<{ q: number; answer: unknown }>;
}

// 학생 응답 detail 에 허용되는 필드만 추림 (correct/student/manualOverride 제외).
function toStudentDetail(d: any) {
  return {
    q: d.q,
    type: d.type,
    multi: d.multi,
    isCorrect: d.isCorrect,
    needsReview: d.needsReview,
  };
}

// 재제출 거부 안내 (제출 불변성 — 제출한 결과는 수정/재제출 불가)
const ALREADY_SUBMITTED_MSG =
  "이미 제출한 시험입니다. 제출한 결과는 수정할 수 없어요. (문의는 선생님께)";

export async function handleSubmit(input: SubmitInput, admin: any) {
  const { teacherCode, examId, name, answers } = input ?? {};

  // 1. 입력 검증 (+ 익명 경로 하드닝: 이름 길이·답안 개수 상한)
  if (!teacherCode || !examId || !name || !Array.isArray(answers))
    return { ok: false, error: "필수 항목 누락" };
  const studentName = String(name).trim();
  if (!studentName) return { ok: false, error: "이름을 입력해주세요." };
  if (studentName.length > 50) return { ok: false, error: "이름이 너무 깁니다." };
  if (answers.length > 500) return { ok: false, error: "답안 항목이 너무 많습니다." };

  // 2. teacherCode → teacher_id
  const { data: t } = await admin.from("teachers")
    .select("id").eq("code", normalizeCode(teacherCode)).maybeSingle();
  if (!t) return { ok: false, error: "존재하지 않는 선생님 코드" };

  // 3. 정답지 조회 (service_role, RLS 우회). 본인 teacher_id 의 시험만.
  const { data: exam } = await admin.from("answer_keys")
    .select("*").eq("id", examId).eq("teacher_id", t.id).maybeSingle();
  if (!exam) return { ok: false, error: "시험을 찾을 수 없습니다." };

  // 4. 제출 불변성 — 같은 시험에 같은 이름으로 이미 제출했으면 거부.
  //    (동시 제출 레이스는 DB unique index 가 최종 차단 → 아래 insert 오류 매핑)
  const { data: dup } = await admin.from("submissions")
    .select("id").eq("exam_id", examId).eq("name", studentName).maybeSingle();
  if (dup) return { ok: false, error: ALREADY_SUBMITTED_MSG };

  // 5. 채점 — 기존 grading.js 그대로 사용
  const graded = gradeSubmission_({ ...exam, questions: exam.questions }, answers);

  // 6. submissions insert — 전체 detail 저장(정답 포함, 교사가 봐야 함)
  //    insert 실패를 삼키면 학생에겐 점수가 보이지만 교사쪽엔 저장 안 되는 유실이 발생 → 반드시 검사.
  const { error: insErr } = await admin.from("submissions").insert({
    teacher_id: t.id, exam_id: examId, name: studentName,
    subject: exam.subject, unit: exam.unit,
    count: graded.count, correct: graded.correct, score: graded.score,
    detail: graded.detail,
  });
  if (insErr) {
    // unique index(submissions_exam_name_unique) 위반 = 동시 재제출 → 같은 안내로 매핑
    if (/duplicate key|unique/i.test(insErr.message))
      return { ok: false, error: ALREADY_SUBMITTED_MSG };
    return { ok: false, error: insErr.message };
  }

  // 7. 안전한 결과만 반환 — 문항별 정답/입력/수동정정 제거 (불변식 2-2)
  return {
    ok: true,
    data: {
      name: studentName,
      subject: exam.subject, unit: exam.unit,
      count: graded.count, correct: graded.correct, score: graded.score,
      detail: graded.detail.map(toStudentDetail),
    },
  };
}
