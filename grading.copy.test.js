// 이식본 동일성 테스트 — CLAUDE.md §2-1
//
// index.html 의 교사 재채점용 채점 모듈 사본이
// supabase/functions/_shared/grading.js 와 "글자 그대로" 같은지 검사한다.
// (허용되는 차이는 export 키워드 제거와 들여쓰기뿐.)
//
// 한쪽만 고치면 학생 제출 채점(Edge Function)과 교사 재채점이 갈라진다.
// 이 테스트가 그 사고를 막는다.
//
// 실행: node grading.copy.test.js

var fs = require('fs');
var path = require('path');

var SRC = fs.readFileSync(path.join(__dirname, 'supabase', 'functions', '_shared', 'grading.js'), 'utf8');
var HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// --- 원본: 헤더 주석을 떼고 export 키워드 제거 ---
var srcIdx = SRC.indexOf('export function normalize_');
if (srcIdx < 0) { console.error('✗ 원본에서 normalize_ 를 찾지 못했습니다.'); process.exit(1); }
var expected = SRC.slice(srcIdx).replace(/\bexport function /g, 'function ').trim();

// --- 사본: index.html 의 Grading IIFE 본문 ---
var open = HTML.indexOf('const Grading = (function () {');
if (open < 0) { console.error('✗ index.html 에서 Grading 모듈을 찾지 못했습니다.'); process.exit(1); }
var bodyStart = HTML.indexOf('function normalize_', open);
var bodyEnd = HTML.indexOf('return { normalize_', open);
if (bodyStart < 0 || bodyEnd < 0 || bodyEnd < bodyStart) {
  console.error('✗ index.html 의 Grading 모듈 본문 범위를 찾지 못했습니다.');
  process.exit(1);
}
var actual = HTML.slice(bodyStart, bodyEnd)
  .split('\n')
  .map(function (l) { return l.replace(/^ {4}/, ''); })   // 삽입 시 더해진 들여쓰기만 제거
  .join('\n')
  .trim();

if (actual !== expected) {
  console.error('\n✗ index.html 의 채점 모듈 사본이 원본과 다릅니다.');
  var a = actual.split('\n'), b = expected.split('\n');
  var shown = 0;
  for (var i = 0; i < Math.max(a.length, b.length) && shown < 10; i++) {
    if (a[i] !== b[i]) {
      console.error('  줄 ' + (i + 1));
      console.error('    원본: ' + JSON.stringify(b[i]));
      console.error('    사본: ' + JSON.stringify(a[i]));
      shown++;
    }
  }
  console.error('\n  → 둘 중 하나만 고치면 안 됩니다. grading.js 를 고치고 사본을 다시 맞추세요.\n');
  process.exit(1);
}

var fnCount = (expected.match(/^function /gm) || []).length;
console.log('✓ 채점 모듈 사본 일치: 함수 ' + fnCount + '개, ' + expected.split('\n').length + '줄 글자 단위 동일');
