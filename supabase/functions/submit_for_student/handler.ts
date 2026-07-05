// submit_for_student — 핵심 로직 (테스트 가능하도록 admin 클라이언트를 주입받는 형태)
// 계약: edge-functions-contract.md §2 (v2: 반+PIN 기반)
// 채점은 grading.js의 gradeSubmission_ 를 그대로 사용 (재구현 금지, 불변식 2-1).
// 응답에서 문항별 정답(correct)·student·manualOverride 를 제거 (불변식 2-2).
import { gradeSubmission_ } from "../_shared/grading.js";

export interface SubmitInput {
  examId?: string;
  classId?: string;
  name?: string;
  pin?: string;
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
  const { examId, classId, name, pin, answers } = input ?? {};

  // 1. 입력 검증 (+ 익명 경로 하드닝: 이름 길이·답안 개수 상한)
  if (!examId || !classId || !name || !pin || !Array.isArray(answers))
    return { ok: false, error: "필수 항목 누락" };
  const studentName = String(name).trim();
  if (!studentName) return { ok: false, error: "이름을 입력해주세요." };
  if (studentName.length > 50) return { ok: false, error: "이름이 너무 깁니다." };
  if (answers.length > 500) return { ok: false, error: "답안 항목이 너무 많습니다." };

  // 2. 학생 PIN 재검증 (DB 함수 student_verify — 해시 비교 단일 소스)
  const { data: studentId, error: vErr } = await admin
    .rpc("student_verify", { p_class_id: classId, p_name: studentName, p_pin: String(pin) });
  if (vErr) return { ok: false, error: vErr.message };
  if (!studentId)
    return { ok: false, error: "이름 또는 PIN이 올바르지 않습니다. (PIN 분실 시 선생님께 초기화 요청)" };

  // 3. 반 → 교사 확인
  const { data: cls } = await admin.from("classes")
    .select("id, teacher_id").eq("id", classId).maybeSingle();
  if (!cls) return { ok: false, error: "반을 찾을 수 없습니다." };

  // 4. 정답지 조회 (service_role, RLS 우회). 해당 교사의 시험 + 반 배정 확인.
  const { data: exam } = await admin.from("answer_keys")
    .select("*").eq("id", examId).eq("teacher_id", cls.teacher_id).maybeSingle();
  if (!exam) return { ok: false, error: "시험을 찾을 수 없습니다." };
  if (exam.class_id != null && exam.class_id !== classId)
    return { ok: false, error: "이 반에서 응시할 수 없는 시험입니다." };

  // 5. 제출 불변성 — 같은 학생이 같은 시험을 이미 제출했으면 거부.
  //    (동시 제출 레이스는 DB unique index 가 최종 차단 → 아래 insert 오류 매핑)
  const { data: dup } = await admin.from("submissions")
    .select("id").eq("exam_id", examId).eq("student_id", studentId).maybeSingle();
  if (dup) return { ok: false, error: ALREADY_SUBMITTED_MSG };

  // 6. 채점 — 기존 grading.js 그대로 사용
  const graded = gradeSubmission_({ ...exam, questions: exam.questions }, answers);

  // 7. submissions insert — 전체 detail 저장(정답 포함, 교사가 봐야 함)
  //    insert 실패를 삼키면 학생에겐 점수가 보이지만 교사쪽엔 저장 안 되는 유실이 발생 → 반드시 검사.
  const { error: insErr } = await admin.from("submissions").insert({
    teacher_id: cls.teacher_id, exam_id: examId, name: studentName,
    class_id: classId, student_id: studentId,
    subject: exam.subject, unit: exam.unit,
    count: graded.count, correct: graded.correct, score: graded.score,
    detail: graded.detail,
  });
  if (insErr) {
    // unique index(submissions_exam_student_unique) 위반 = 동시 재제출 → 같은 안내로 매핑
    if (/duplicate key|unique/i.test(insErr.message))
      return { ok: false, error: ALREADY_SUBMITTED_MSG };
    return { ok: false, error: insErr.message };
  }

  // 8. 안전한 결과만 반환 — 문항별 정답/입력/수동정정 제거 (불변식 2-2)
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
