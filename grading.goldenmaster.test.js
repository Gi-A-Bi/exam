// 골든마스터 회귀 테스트 — CLAUDE.md §2-1 (채점 결과 비트 단위 동일)
//
// 목적: 분리 전 원본 함수(Code.gs 스냅샷)의 출력과
//      분리 후 grading.js의 출력이 모든 대표 입력에서 정확히 일치함을 검증.
//
// 실행: node grading.goldenmaster.test.js   (의존성 없음, Node 내장 assert만 사용)

var assert = require('assert');
var sep = require('./grading.js'); // 분리 후 모듈

// =====================================================================
// ORIGINAL — Code.gs 에서 그대로 복사한 분리 전 원본 함수 스냅샷.
// 이 블록은 골든마스터의 "기준값"이며 절대 수정하지 않습니다.
// (grading.js 로 옮기기 전의 동작을 고정해 둔 것.)
// =====================================================================
var orig = (function () {
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

  return {
    normalize_: normalize_,
    levenshtein_: levenshtein_,
    isAmbiguous_: isAmbiguous_,
    gradeMcMulti_: gradeMcMulti_,
    toDisplay_: toDisplay_,
    gradeSubmission_: gradeSubmission_
  };
})();

// =====================================================================
// 대표 입력 세트
// =====================================================================

// --- normalize_ ---
var NORMALIZE_INPUTS = [
  null, undefined, '', '  ', 'Hello', '  Hello  World  ', 'A B C',
  '서울특별시', '서 울', '정답.', '안녕!?', "it's", '"인용"', '중점·기호',
  123, 0, true, '대한민국,입니다', 'Mixed.Case! Test'
];

// --- levenshtein_ ---
var LEVENSHTEIN_INPUTS = [
  ['', ''], ['a', ''], ['', 'abc'], ['abc', 'abc'], ['abc', 'abd'],
  ['kitten', 'sitting'], ['flaw', 'lawn'], ['서울', '서울시'],
  ['대한민국', '대한민귝'], ['short', 'shorter'], ['abc', 'xyz']
];

// --- isAmbiguous_ ---
var ISAMBIGUOUS_INPUTS = [
  ['', ['답']],
  ['답', null],
  ['답', []],
  ['서울', ['서울']],            // 완전 일치 → false
  ['서울시', ['서울']],          // 부분 문자열, 길이차 1 → true
  ['삼각형', ['사각형']],        // maxLen<=4, dist=1 → true
  ['이등변삼각형', ['직각삼각형']], // 긴 문자열 유사도
  ['photosynthesis', ['photosynthesys']], // maxLen>4, dist/maxLen<=0.3 → true
  ['apple', ['orange']],         // 무관 → false
  ['대한', ['대한민국']],        // 부분 문자열, 길이차 2 → true
  ['가나다라마바사', ['가']],    // 부분 문자열, 길이차 6 → false
  ['ABCD', ['abce']],            // 정규화 후 maxLen=4, dist=1 → true
  ['hello world', ['helloworld']] // 정규화 후 동일 → false
];

// --- gradeMcMulti_ ---
var GRADEMCMULTI_INPUTS = [
  [[1, 3], [1, 3]],         // 정답
  [[1, 3], [3, 1]],         // 순서 무관 → 정답
  [[1, 3], [1, 2]],         // 오답
  [[1, 3], [1]],            // 개수 부족
  [[1, 3], [1, 3, 4]],      // 개수 초과
  [[1, 3], '1,3'],          // 콤마 문자열 입력
  [[1, 3], '3,1'],          // 콤마 문자열, 순서 무관
  [[1, 3], null],           // 미응답
  [[1, 3], ''],             // 빈 문자열
  [[], [1]],                // 정답 없음
  [['1', '3'], ['1', '3']], // 문자열 배열
  [[1, 3], [0, 1, 3]],      // 0 필터링됨 → 개수 불일치
  [[2], 2],                 // 스칼라 단일
  [[1, 2, 3], [3, 2, 1]]    // 3개 순서 무관
];

// --- toDisplay_ ---
var TODISPLAY_INPUTS = [
  null, undefined, '', 'text', 123, 0, [1, 2, 3], [], ['a', 'b'], true, [1]
];

// --- gradeSubmission_ : 대표 시험지 + 다양한 제출 ---
var EXAM = {
  questions: [
    { q: 1, type: 'mc', answer: 3 },                       // 객관식 단일
    { q: 2, type: 'mc', multi: true, answers: [1, 3] },    // 객관식 복수
    { q: 3, type: 'short', answers: ['서울', '서울특별시'] }, // 주관식
    { q: 4, type: 'short', answers: ['photosynthesis'] }   // 주관식 (유사답안 테스트용)
  ]
};

var SUBMISSIONS = [
  // 모두 정답
  [{ q: 1, answer: 3 }, { q: 2, answer: [1, 3] }, { q: 3, answer: '서울' }, { q: 4, answer: 'photosynthesis' }],
  // 모두 오답
  [{ q: 1, answer: 1 }, { q: 2, answer: [2] }, { q: 3, answer: '부산' }, { q: 4, answer: 'mitochondria' }],
  // 복수정답 순서 무관 + 주관식 유사답안(needsReview)
  [{ q: 1, answer: 3 }, { q: 2, answer: [3, 1] }, { q: 3, answer: '서울시' }, { q: 4, answer: 'photosynthesys' }],
  // 미응답 섞임
  [{ q: 1, answer: 3 }, { q: 4, answer: 'photosynthesis' }],
  // 복수정답 콤마 문자열 + 주관식 정규화 동치
  [{ q: 1, answer: '3' }, { q: 2, answer: '1,3' }, { q: 3, answer: ' 서울 특별시 ' }, { q: 4, answer: 'Photosynthesis.' }],
  // 빈 제출
  []
];

// 빈 시험지 케이스 (score=0 경로)
var EMPTY_EXAM = { questions: [] };

// =====================================================================
// 실행 & 비교 헬퍼
// =====================================================================
var passed = 0;
var failures = [];

function check(name, args, a, b) {
  var ja = JSON.stringify(a);
  var jb = JSON.stringify(b);
  try {
    assert.deepStrictEqual(b, a);
    if (ja !== jb) throw new Error('직렬화 불일치');
    passed++;
  } catch (e) {
    failures.push(name + '  입력=' + JSON.stringify(args) +
      '\n    원본 = ' + ja + '\n    분리 = ' + jb);
  }
}

NORMALIZE_INPUTS.forEach(function (x) {
  check('normalize_', x, orig.normalize_(x), sep.normalize_(x));
});

LEVENSHTEIN_INPUTS.forEach(function (p) {
  check('levenshtein_', p, orig.levenshtein_(p[0], p[1]), sep.levenshtein_(p[0], p[1]));
});

ISAMBIGUOUS_INPUTS.forEach(function (p) {
  check('isAmbiguous_', p, orig.isAmbiguous_(p[0], p[1]), sep.isAmbiguous_(p[0], p[1]));
});

GRADEMCMULTI_INPUTS.forEach(function (p) {
  check('gradeMcMulti_', p, orig.gradeMcMulti_(p[0], p[1]), sep.gradeMcMulti_(p[0], p[1]));
});

TODISPLAY_INPUTS.forEach(function (x) {
  check('toDisplay_', x, orig.toDisplay_(x), sep.toDisplay_(x));
});

SUBMISSIONS.forEach(function (sub, i) {
  check('gradeSubmission_[' + i + ']', sub, orig.gradeSubmission_(EXAM, sub), sep.gradeSubmission_(EXAM, sub));
});
check('gradeSubmission_[empty-exam]', [], orig.gradeSubmission_(EMPTY_EXAM, []), sep.gradeSubmission_(EMPTY_EXAM, []));

// =====================================================================
// 결과 리포트
// =====================================================================
var total = passed + failures.length;
if (failures.length === 0) {
  console.log('✓ 골든마스터 통과: ' + total + '/' + total + ' 케이스 비트 단위 일치');
  process.exit(0);
} else {
  console.error('✗ 골든마스터 실패: ' + failures.length + '/' + total + ' 케이스 불일치\n');
  failures.forEach(function (f) { console.error('  • ' + f + '\n'); });
  process.exit(1);
}
