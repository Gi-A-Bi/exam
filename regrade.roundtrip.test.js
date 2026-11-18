// 재채점 왕복 테스트 — CLAUDE.md §2-1 (채점 결과 비트 단위 동일)
//
// 목적: 정답지를 고쳤을 때 기존 제출물을 "다시 채점"하는 경로가
//      제출 당시와 같은 입력을 쓰는지 증명한다.
//
// 배경: submissions 에는 학생의 원본 답안이 따로 저장되지 않는다.
//      detail[].student 에 toDisplay_ 를 거친 표시형만 남는다.
//        · 객관식 단일 3      → '3'
//        · 복수정답 [1,3]     → '1,3'
//        · 주관식 '서울'      → '서울'
//        · 무응답 undefined   → ''
//      교사 화면의 재채점은 이 표시형을 answers 로 되돌려 쓴다. 그래도 결과가
//      같아야 한다 — 다르면 "정답지를 고쳤더니 안 바꾼 문항 점수까지 변했다"가 된다.
//
// 검증: 같은 정답지로 다시 채점했을 때 detail/correct/score 가 원본과 완전히 일치.
//      (정답지를 바꾼 경우의 결과는 당연히 달라져야 하므로 여기서 검증하지 않는다.)
//
// 실행: node regrade.roundtrip.test.js   (의존성 없음, Node 내장 assert만 사용)

var assert = require('assert');
var path = require('path');
var SEP_PATH = require('url').pathToFileURL(
  path.join(__dirname, 'supabase', 'functions', '_shared', 'grading.js')
).href;

// --- 교사 화면(index.html)의 answersFromDetail 과 같은 규칙 ---
function answersFromDetail(detail) {
  return (detail || []).map(function (d) { return { q: d.q, answer: d.student }; });
}

// --- 대표 시험지: 세 가지 문항 유형을 모두 포함 ---
var EXAM = {
  questions: [
    { q: 1, type: 'mc', answer: 3 },
    { q: 2, type: 'mc', multi: true, answers: [1, 3] },
    { q: 3, type: 'short', answers: ['서울', '서울특별시'] },
    { q: 4, type: 'short', answers: ['photosynthesis'] },
    { q: 5, type: 'mc', multi: true, answers: [2, 4, 5] }
  ]
};

var SUBMISSIONS = [
  // 모두 정답
  [{ q: 1, answer: 3 }, { q: 2, answer: [1, 3] }, { q: 3, answer: '서울' }, { q: 4, answer: 'photosynthesis' }, { q: 5, answer: [2, 4, 5] }],
  // 모두 오답
  [{ q: 1, answer: 1 }, { q: 2, answer: [2] }, { q: 3, answer: '부산' }, { q: 4, answer: 'mitochondria' }, { q: 5, answer: [1] }],
  // 복수정답 순서 무관 + 주관식 유사답안(needsReview 경로)
  [{ q: 1, answer: 3 }, { q: 2, answer: [3, 1] }, { q: 3, answer: '서울시' }, { q: 4, answer: 'photosynthesys' }, { q: 5, answer: [5, 2, 4] }],
  // 미응답 섞임 (2,3,5번 무응답)
  [{ q: 1, answer: 3 }, { q: 4, answer: 'photosynthesis' }],
  // 이미 문자열로 들어온 경우 + 주관식 정규화 동치
  [{ q: 1, answer: '3' }, { q: 2, answer: '1,3' }, { q: 3, answer: ' 서울 특별시 ' }, { q: 4, answer: 'Photosynthesis.' }, { q: 5, answer: '2,4,5' }],
  // 빈 제출 (전 문항 무응답)
  [],
  // 복수정답에 개수만 맞고 값이 다른 경우
  [{ q: 1, answer: 5 }, { q: 2, answer: [2, 4] }, { q: 3, answer: '' }, { q: 4, answer: '   ' }, { q: 5, answer: [2, 4, 9] }],
  // null / 0 같은 가장자리 값
  [{ q: 1, answer: null }, { q: 2, answer: [] }, { q: 3, answer: null }, { q: 4, answer: '' }, { q: 5, answer: 0 }]
];

var EMPTY_EXAM = { questions: [] };

var passed = 0;
var failures = [];

function check(label, expected, actual) {
  try {
    assert.deepStrictEqual(actual, expected);
    passed++;
  } catch (e) {
    failures.push(label + '\n    기대: ' + JSON.stringify(expected) + '\n    실제: ' + JSON.stringify(actual));
  }
}

import(SEP_PATH).then(function (g) {
  SUBMISSIONS.forEach(function (answers, i) {
    // 1) 제출 당시 채점
    var first = g.gradeSubmission_(EXAM, answers);
    // 2) 저장된 detail 에서 답안을 되돌려 같은 정답지로 재채점
    var again = g.gradeSubmission_(EXAM, answersFromDetail(first.detail));

    check('왕복[' + i + '].detail', first.detail, again.detail);
    check('왕복[' + i + '].correct', first.correct, again.correct);
    check('왕복[' + i + '].score', first.score, again.score);
    check('왕복[' + i + '].count', first.count, again.count);

    // 3) 2회 이상 반복해도 흔들리지 않아야 한다 (재채점을 여러 번 눌러도 동일)
    var third = g.gradeSubmission_(EXAM, answersFromDetail(again.detail));
    check('왕복[' + i + '].고정점', again.detail, third.detail);
  });

  // 빈 시험지 경로
  var e1 = g.gradeSubmission_(EMPTY_EXAM, []);
  check('왕복[empty-exam]', e1, g.gradeSubmission_(EMPTY_EXAM, answersFromDetail(e1.detail)));

  if (failures.length) {
    console.error('\n✗ 재채점 왕복 실패 ' + failures.length + '건 (통과 ' + passed + '건)\n');
    failures.forEach(function (f) { console.error('  • ' + f + '\n'); });
    process.exit(1);
  }
  console.log('✓ 재채점 왕복 통과: ' + passed + '/' + passed + ' 케이스 비트 단위 일치');
}).catch(function (e) {
  console.error('모듈 로드 실패:', e);
  process.exit(1);
});
