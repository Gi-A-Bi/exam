// ===== 채점 (grading) =====
// CLAUDE.md §2-1 불변식: 아래 함수들의 입출력 동작은 기존 Code.gs와 비트 단위로 동일해야 합니다.
// 새로 짜지 말고 그대로 이식 — 동작 변경 금지.
//
// Google Apps Script(전역 함수)와 Node(테스트용 module.exports) 양쪽에서 동작하도록
// UMD 스타일로 노출합니다. GAS에서는 typeof module === 'undefined' 이므로 전역 함수로 남고,
// Node에서는 module.exports 로 import 가능합니다.

function normalize_(s) {
  if (s == null) return '';
  return String(s).trim().toLowerCase().replace(/\s+/g, '').replace(/[.,!?'"·]/g, '');
}

function levenshtein_(a, b) {
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

function isAmbiguous_(student, answers) {
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

function gradeMcMulti_(correctArr, studentAns) {
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

function toDisplay_(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(',');
  return String(v);
}

function gradeSubmission_(exam, answers) {
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

// Node 환경에서만 export (GAS에서는 module 이 정의되어 있지 않아 전역 함수로 유지됨).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalize_: normalize_,
    levenshtein_: levenshtein_,
    isAmbiguous_: isAmbiguous_,
    gradeMcMulti_: gradeMcMulti_,
    toDisplay_: toDisplay_,
    gradeSubmission_: gradeSubmission_
  };
}
