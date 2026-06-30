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

export async function handleSubmit(input: SubmitInput, admin: any) {
  const { teacherCode, examId, name, answers } = input ?? {};

  // 1. 입력 검증
  if (!teacherCode || !examId || !name || !Array.isArray(answers))
    return { ok: false, error: "필수 항목 누락" };

  // 2. teacherCode → teacher_id
  const { data: t } = await admin.from("teachers")
    .select("id").eq("code", normalizeCode(teacherCode)).maybeSingle();
  if (!t) return { ok: false, error: "존재하지 않는 선생님 코드" };

  // 3. 정답지 조회 (service_role, RLS 우회). 본인 teacher_id 의 시험만.
  const { data: exam } = await admin.from("answer_keys")
    .select("*").eq("id", examId).eq("teacher_id", t.id).maybeSingle();
  if (!exam) return { ok: false, error: "시험을 찾을 수 없습니다." };

  // 4. 채점 — 기존 grading.js 그대로 사용
  const graded = gradeSubmission_({ ...exam, questions: exam.questions }, answers);

  // 5. submissions insert — 전체 detail 저장(정답 포함, 교사가 봐야 함)
  await admin.from("submissions").insert({
    teacher_id: t.id, exam_id: examId, name: String(name).trim(),
    subject: exam.subject, unit: exam.unit,
    count: graded.count, correct: graded.correct, score: graded.score,
    detail: graded.detail,
  });

  // 6. 안전한 결과만 반환 — 문항별 정답/입력/수동정정 제거 (불변식 2-2)
  return {
    ok: true,
    data: {
      name: String(name).trim(),
      subject: exam.subject, unit: exam.unit,
      count: graded.count, correct: graded.correct, score: graded.score,
      detail: graded.detail.map(toStudentDetail),
    },
  };
}
