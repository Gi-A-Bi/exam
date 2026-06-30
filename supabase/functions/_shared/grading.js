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
