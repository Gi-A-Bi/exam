// @ts-nocheck — grading.js(무타입 JS 원본 포함)로 인한 타입경고 억제. 문법 오류는 여전히 검출됨.
// submit_for_student — 대시보드 배포용 단일 파일 번들 (자동 생성)
// 원본: supabase/functions/submit_for_student/{index,handler}.ts + _shared/{cors.ts,grading.js}
// 채점 함수는 _shared/grading.js 를 기계적으로 포함한 것(불변식 2-1: 재구현 아님).
import { createClient } from "jsr:@supabase/supabase-js@2";

// ===== _shared/cors.ts =====
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

// ===== _shared/grading.js (원본 그대로) =====
// ===== 채점 (grading) =====
// CLAUDE.md §2-1 불변식: 아래 함수들의 입출력 동작은 기존 Code.gs와 비트 단위로 동일해야 합니다.
// 새로 짜지 말고 그대로 이식 — 동작 변경 금지.
//
// ESM 모듈로 노출합니다. Supabase Edge Function(Deno)이 그대로 import 하고,
// 골든마스터 테스트(Node)는 dynamic import 로 동일 모듈을 검증합니다.
// 함수 본문은 기존 Code.gs 원본을 글자 그대로 이식한 것입니다 (로직 변경 없음).

export function normalize_(s) {
  if (s == null) return '';
  return String(s).trim().toLowerCase().replace(/\s+/g, '').replace(/[.,!?'"·]/g, '');
}

export function levenshtein_(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  var dp = [];
  for (var i = 0; i <= a.length; i++) dp.push(i);
  for (var j = 1; j <= b.length; j++) {
    var prev = dp[0]; dp[0] = j;
    for (var i2 = 1; i2 <= a.length; i2++) {
      var tmp = dp[i2];
      dp[i2] = a[i2-1] === b[j-1] ? prev : Math.min(prev, dp[i2-1], dp[i2]) + 1;
      prev = tmp;
    }
  }
  return dp[a.length];
}

export function isAmbiguous_(student, answers) {
  if (!student || !answers || !answers.length) return false;
  var s = normalize_(student);
  if (!s) return false;
  for (var i = 0; i < answers.length; i++) {
    var na = normalize_(answers[i]);
    if (!na || s === na) return false;
    var dist = levenshtein_(s, na);
    var maxLen = Math.max(s.length, na.length);
    if (maxLen <= 4 && dist === 1) return true;
    if (maxLen > 4 && dist / maxLen <= 0.3) return true;
    if (s.indexOf(na) !== -1 || na.indexOf(s) !== -1) {
      if (Math.abs(s.length - na.length) <= 3) return true;
    }
  }
  return false;
}

export function gradeMcMulti_(correctArr, studentAns) {
  var correctSet = (correctArr || []).map(Number).filter(function(v){ return v > 0; })
                                     .sort(function(a, b) { return a - b; });
  if (correctSet.length === 0) return false;
  var givenSet;
  if (Array.isArray(studentAns)) {
    givenSet = studentAns;
  } else if (studentAns != null && studentAns !== '') {
    givenSet = String(studentAns).split(',');
  } else {
    return false;
  }
  givenSet = givenSet.map(Number).filter(function(v){ return v > 0; })
                     .sort(function(a, b) { return a - b; });
  if (givenSet.length !== correctSet.length) return false;
  for (var i = 0; i < correctSet.length; i++) {
    if (correctSet[i] !== givenSet[i]) return false;
  }
  return true;
}

export function toDisplay_(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(',');
  return String(v);
}

export function gradeSubmission_(exam, answers) {
  var questions = exam.questions || [];
  var ansMap = {};
  answers.forEach(function(a) { ansMap[a.q] = a.answer; });

  var correct = 0;
  var detail = [];
  for (var i = 0; i < questions.length; i++) {
    var q = questions[i];
    var studentAns = ansMap[q.q];
    var isCorrect = false;
    var correctDisplay = '';
    var needsReview = false;

    if (q.type === 'mc') {
      if (q.multi) {
        var sortedAnswers = (q.answers || []).slice().map(Number).sort(function(a,b){return a-b;});
        correctDisplay = sortedAnswers.join(',');
        isCorrect = gradeMcMulti_(q.answers, studentAns);
      } else {
        correctDisplay = q.answer;
        isCorrect = (studentAns != null && parseInt(studentAns) === parseInt(q.answer));
      }
    } else {
      var correctAnswers = q.answers || [];
      correctDisplay = correctAnswers.join(' / ');
      if (studentAns) {
        var norm = normalize_(studentAns);
        isCorrect = correctAnswers.some(function(a) { return normalize_(a) === norm; });
        if (!isCorrect) {
          needsReview = isAmbiguous_(studentAns, correctAnswers);
        }
      }
    }
    if (isCorrect) correct++;
    detail.push({
      q: q.q,
      type: q.type,
      multi: !!q.multi,
      student: toDisplay_(studentAns),
      correct: toDisplay_(correctDisplay),
      isCorrect: isCorrect,
      needsReview: needsReview,
      manualOverride: null
    });
  }
  var score = questions.length > 0 ? Math.round((correct / questions.length) * 100) : 0;
  return { count: questions.length, correct: correct, score: score, detail: detail };
}

// ===== submit_for_student/handler.ts =====
// submit_for_student — 핵심 로직 (테스트 가능하도록 admin 클라이언트를 주입받는 형태)
// 계약: edge-functions-contract.md §2 (v2: 반+PIN 기반)
// 채점은 grading.js의 gradeSubmission_ 를 그대로 사용 (재구현 금지, 불변식 2-1).
// 응답에서 문항별 정답(correct)·student·manualOverride 를 제거 (불변식 2-2).

export interface SubmitInput {
  examId?: string;
  classId?: string;
  number?: number | string;
  name?: string;
  pin?: string;
  awayCount?: number | string;
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
  const { examId, classId, number, name, pin, awayCount, answers } = input ?? {};
  // 이탈 횟수(부정행위 억제용) — 신뢰 못 하는 클라이언트 값이므로 0~100000으로 클램프.
  const away = Math.max(0, Math.min(100000, parseInt(String(awayCount ?? 0), 10) || 0));

  // 1. 입력 검증 (+ 익명 경로 하드닝: 이름 길이·답안 개수 상한)
  if (!examId || !classId || number == null || !name || !pin || !Array.isArray(answers))
    return { ok: false, error: "필수 항목 누락" };
  const studentName = String(name).trim();
  const studentNumber = parseInt(String(number), 10);
  if (!studentName) return { ok: false, error: "이름을 입력해주세요." };
  if (studentName.length > 50) return { ok: false, error: "이름이 너무 깁니다." };
  if (!(studentNumber >= 1 && studentNumber <= 999))
    return { ok: false, error: "번호가 올바르지 않습니다." };
  if (answers.length > 500) return { ok: false, error: "답안 항목이 너무 많습니다." };

  // 2. 학생 PIN 재검증 (DB 함수 student_verify — 번호+PIN, 해시 비교 단일 소스)
  const { data: studentId, error: vErr } = await admin
    .rpc("student_verify", { p_class_id: classId, p_number: studentNumber, p_pin: String(pin) });
  if (vErr) return { ok: false, error: vErr.message };
  if (!studentId)
    return { ok: false, error: "번호 또는 PIN이 올바르지 않습니다. (PIN 분실 시 선생님께 초기화 요청)" };

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
    number: studentNumber, away_count: away,
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

// ===== submit_for_student/index.ts (진입점) =====
// submit_for_student Edge Function — HTTP 진입점 (계약: edge-functions-contract.md §2)
// 로직은 handler.ts(handleSubmit)에 있고, 여기서는 admin 클라이언트 생성 + req/res 연결만.

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(withCors(async (req) => {
  const body = await req.json();
  return handleSubmit(body, admin);
}));
