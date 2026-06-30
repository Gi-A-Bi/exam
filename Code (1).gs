/*****************************************************************
 * OMR 자동 채점 시스템 v5.2 - 최종 완성본
 *
 * v5.1 → v5.2 변경점:
 *  - 학생 제출 응답(submit_for_student)에서 정답(correct) 필드 제거
 *    → 학생은 맞았는지 틀렸는지만 알 수 있고, 정답은 알 수 없음
 *  - 선생님 결과 조회(list_submissions)에서는 정답 그대로 표시
 *
 * 문항 데이터 형식 (questionsJson 안):
 *  - 객관식 단일: { q:1, type:'mc', answer: 3 }
 *  - 객관식 복수: { q:2, type:'mc', multi: true, answers: [1,3] }
 *  - 주관식:     { q:3, type:'short', answers: ['답1','답2'] }
 *
 * 학생이 보내는 답안 형식 (submit_for_student의 answers):
 *  - 객관식 단일: { q: 1, answer: 3 }
 *  - 객관식 복수: { q: 2, answer: [1, 3] }
 *  - 주관식:     { q: 3, answer: '정답텍스트' }
 *****************************************************************/


// ===== 학교 설정 =====
const DEFAULT_SCHOOL_NAME = '서울송정초등학교';
const DEFAULT_JOIN_CODE   = 'sjes2026';


// ===== 메인 엔트리 =====
function doGet(e) {
  if (e && e.parameter && e.parameter.api === '1') {
    return jsonResp_({ ok: true, msg: 'OMR v5.2 backend alive.' });
  }
  const html = HtmlService.createTemplateFromFile('index');
  html.backendUrl = ScriptApp.getService().getUrl();
  html.schoolName = getSetting_('schoolName', DEFAULT_SCHOOL_NAME);
  return html.evaluate()
    .setTitle('OMR 채점 - ' + html.schoolName)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action || '';

    // ===== Public 액션 (인증 불필요) =====
    if (action === 'info') {
      return jsonResp_({ ok: true, data: {
        schoolName: getSetting_('schoolName', DEFAULT_SCHOOL_NAME)
      }});
    }

    if (action === 'register_teacher') {
      const d = body.data || {};
      const joinCode = getSetting_('joinCode', DEFAULT_JOIN_CODE);
      if (!d.joinCode || d.joinCode !== joinCode) {
        return jsonResp_({ ok: false, error: '가입코드가 일치하지 않습니다. 관리 선생님께 문의하세요.' });
      }
      if (!d.code || !d.name || !d.password) {
        return jsonResp_({ ok: false, error: '코드, 이름, 비밀번호가 모두 필요합니다.' });
      }
      if (d.password.length < 6) {
        return jsonResp_({ ok: false, error: '비밀번호는 6자 이상이어야 합니다.' });
      }
      const code = normalizeCode_(d.code);
      if (code.length < 3) {
        return jsonResp_({ ok: false, error: '코드는 영문/숫자 3자 이상이어야 합니다.' });
      }
      const existing = findTeacher_(code);
      if (existing) {
        return jsonResp_({ ok: false, error: '이미 사용 중인 코드입니다. 다른 코드를 선택해주세요.' });
      }
      const salt = Utilities.getUuid();
      const pwHash = hashPassword_(d.password, salt);
      insert_('teachers', {
        code: code,
        name: d.name.trim(),
        pwHash: pwHash,
        salt: salt,
        createdAt: new Date().toISOString()
      });
      const token = createToken_(code);
      return jsonResp_({ ok: true, data: { code, name: d.name.trim(), token } });
    }

    if (action === 'login_teacher') {
      const d = body.data || {};
      if (!d.code || !d.password) {
        return jsonResp_({ ok: false, error: '코드와 비밀번호를 입력해주세요.' });
      }
      const code = normalizeCode_(d.code);
      const t = findTeacher_(code);
      if (!t) return jsonResp_({ ok: false, error: '존재하지 않는 코드입니다.' });
      const pwHash = hashPassword_(d.password, t.salt);
      if (pwHash !== t.pwHash) {
        return jsonResp_({ ok: false, error: '비밀번호가 일치하지 않습니다.' });
      }
      const token = createToken_(code);
      return jsonResp_({ ok: true, data: { code: t.code, name: t.name, token } });
    }

    if (action === 'check_teacher_exists') {
      const d = body.data || {};
      const code = normalizeCode_(d.code || '');
      const t = findTeacher_(code);
      if (!t) return jsonResp_({ ok: false, error: '존재하지 않는 선생님 코드입니다.' });
      return jsonResp_({ ok: true, data: { code: t.code, name: t.name } });
    }

    if (action === 'list_exams_for_student') {
      // 학생용: 시험 목록 (정답 가림, multi 플래그만 노출)
      const d = body.data || {};
      const code = normalizeCode_(d.teacherCode || '');
      const t = findTeacher_(code);
      if (!t) return jsonResp_({ ok: false, error: '존재하지 않는 선생님 코드입니다.' });
      const all = listAll_('answer_keys');
      const safe = all.filter(function(it) { return it.teacherCode === code; })
        .map(function(it) {
          const qs = parseJson_(it.questionsJson) || [];
          return {
            id: it.id,
            subject: it.subject,
            unit: it.unit,
            count: it.count,
            choices: it.choices,
            questions: qs.map(function(q) {
              return { q: q.q, type: q.type, multi: !!q.multi };
            }),
            createdAt: it.createdAt
          };
        });
      return jsonResp_({ ok: true, data: safe });
    }

    if (action === 'submit_for_student') {
      const d = body.data || {};
      const code = normalizeCode_(d.teacherCode || '');
      if (!code || !d.examId || !d.name || !Array.isArray(d.answers)) {
        return jsonResp_({ ok: false, error: '선생님 코드, 시험ID, 이름, 답안이 필요합니다.' });
      }
      const t = findTeacher_(code);
      if (!t) return jsonResp_({ ok: false, error: '존재하지 않는 선생님 코드입니다.' });
      const exam = getExamById_(d.examId, code);
      if (!exam) return jsonResp_({ ok: false, error: '시험을 찾을 수 없습니다.' });
      var graded = gradeSubmission_(exam, d.answers);
      insert_('submissions', {
        teacherCode: code,
        examId: d.examId,
        name: d.name.trim(),
        subject: exam.subject,
        unit: exam.unit,
        count: graded.count,
        correct: graded.correct,
        score: graded.score,
        detailJson: JSON.stringify(graded.detail),
        submittedAt: new Date().toISOString()
      });
      // ★ 학생에게는 정답(correct)을 숨기고 정오 여부만 전달
      return jsonResp_({ ok: true, data: {
        name: d.name.trim(),
        subject: exam.subject,
        unit: exam.unit,
        count: graded.count,
        correct: graded.correct,
        score: graded.score,
        detail: graded.detail.map(function(item) {
          return {
            q: item.q,
            type: item.type,
            multi: item.multi,
            isCorrect: item.isCorrect,
            needsReview: item.needsReview
          };
        })
      }});
    }

    // ===== 인증 필요 액션 =====
    const auth = verifyToken_(body.token);
    if (!auth.ok) return jsonResp_({ ok: false, error: '로그인이 필요합니다.', authRequired: true });
    const myCode = auth.code;

    if (action === 'list_exams') {
      var all = listAll_('answer_keys');
      var mine = all.filter(function(it) { return it.teacherCode === myCode; })
        .map(function(it) {
          return {
            id: it.id,
            subject: it.subject,
            unit: it.unit,
            count: it.count,
            choices: it.choices,
            questions: parseJson_(it.questionsJson) || [],
            createdAt: it.createdAt
          };
        });
      return jsonResp_({ ok: true, data: mine });
    }

    if (action === 'add_exam') {
      var d2 = body.data || {};
      if (!d2.subject || !d2.unit || !Array.isArray(d2.questions) || d2.questions.length === 0) {
        return jsonResp_({ ok: false, error: '과목, 단원, 문항이 필요합니다.' });
      }
      var validation = validateQuestions_(d2.questions);
      if (!validation.ok) {
        return jsonResp_({ ok: false, error: validation.error });
      }
      var r2 = insert_('answer_keys', {
        teacherCode: myCode,
        subject: d2.subject,
        unit: d2.unit,
        count: d2.questions.length,
        choices: d2.choices || 5,
        questionsJson: JSON.stringify(d2.questions),
        createdAt: new Date().toISOString()
      });
      return jsonResp_({ ok: true, data: { id: r2.id } });
    }

    if (action === 'delete_exam') {
      var examId = body.id;
      var exam2 = getExamById_(examId, myCode);
      if (!exam2) return jsonResp_({ ok: false, error: '시험을 찾을 수 없거나 권한이 없습니다.' });
      deleteRow_('answer_keys', examId);
      return jsonResp_({ ok: true });
    }

    if (action === 'list_submissions') {
      // ★ 선생님용: 정답(correct) 포함하여 전체 detail 전달
      var allSubs = listAll_('submissions');
      var mineSubs = allSubs.filter(function(it) { return it.teacherCode === myCode; })
        .map(function(it) {
          return {
            id: it.id,
            name: it.name,
            examId: it.examId,
            subject: it.subject,
            unit: it.unit,
            count: it.count,
            correct: it.correct,
            score: it.score,
            detail: parseJson_(it.detailJson) || [],
            submittedAt: it.submittedAt
          };
        });
      return jsonResp_({ ok: true, data: mineSubs });
    }

    if (action === 'update_submission') {
      var d3 = body.data || {};
      var sub = findSubmissionById_(d3.id, myCode);
      if (!sub) return jsonResp_({ ok: false, error: '응시 기록을 찾을 수 없습니다.' });
      var detail3 = d3.detail;
      var correct3 = 0;
      for (var k = 0; k < detail3.length; k++) {
        var x = detail3[k];
        var eff = x.manualOverride != null ? x.manualOverride : x.isCorrect;
        if (eff) correct3++;
      }
      var score3 = detail3.length > 0 ? Math.round((correct3 / detail3.length) * 100) : 0;
      updateRow_('submissions', d3.id, {
        correct: correct3,
        score: score3,
        detailJson: JSON.stringify(detail3)
      });
      return jsonResp_({ ok: true, data: { correct: correct3, score: score3 } });
    }

    return jsonResp_({ ok: false, error: '알 수 없는 액션: ' + action });
  } catch (err) {
    return jsonResp_({ ok: false, error: String(err && err.message || err) });
  }
}


// ===== 초기 설정 (한 번만 수동 실행) =====
function setup() {
  var ss = getSpreadsheet_();
  getOrCreateSheet_('teachers', ['code', 'name', 'pwHash', 'salt', 'createdAt']);
  getOrCreateSheet_('answer_keys', ['id', 'teacherCode', 'subject', 'unit', 'count', 'choices', 'questionsJson', 'createdAt']);
  getOrCreateSheet_('submissions', ['id', 'teacherCode', 'examId', 'name', 'subject', 'unit', 'count', 'correct', 'score', 'detailJson', 'submittedAt']);
  getOrCreateSheet_('settings', ['key', 'value']);
  setSetting_('schoolName', DEFAULT_SCHOOL_NAME);
  if (!getSetting_('joinCode', null)) {
    setSetting_('joinCode', DEFAULT_JOIN_CODE);
  }
  if (!getSetting_('tokenSecret', null)) {
    setSetting_('tokenSecret', Utilities.getUuid());
  }
  Logger.log('=== 초기 설정 완료 ===');
  Logger.log('스프레드시트 URL: ' + ss.getUrl());
  Logger.log('현재 학교명: ' + getSetting_('schoolName'));
  Logger.log('현재 가입코드: ' + getSetting_('joinCode'));
}

function setJoinCode() {
  var newCode = 'sjes2026';   // ← 변경 시 여기만 수정 후 실행
  setSetting_('joinCode', newCode);
  Logger.log('가입코드가 변경되었습니다: ' + newCode);
}

function setSchoolName() {
  var newName = '서울송정초등학교';   // ← 변경 시 여기만 수정 후 실행
  setSetting_('schoolName', newName);
  Logger.log('학교 이름이 변경되었습니다: ' + newName);
}


// ===== 스프레드시트 헬퍼 =====
function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('spreadsheetId');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) {}
  }
  var ss = SpreadsheetApp.create('OMR 채점 데이터 (' + DEFAULT_SCHOOL_NAME + ')');
  props.setProperty('spreadsheetId', ss.getId());
  var def = ss.getSheetByName('Sheet1');
  if (def) ss.deleteSheet(def);
  return ss;
}

function getOrCreateSheet_(name, headers) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f0f0f0');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function listAll_(table) {
  var sheet = getOrCreateSheet_(table, getDefaultHeaders_(table));
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = data[i][j];
    rows.push(obj);
  }
  return rows;
}

function insert_(table, obj) {
  var sheet = getOrCreateSheet_(table, getDefaultHeaders_(table));
  if (!obj.id) obj.id = table.charAt(0) + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row = headers.map(function(h) { return obj[h] == null ? '' : obj[h]; });
  sheet.appendRow(row);
  return obj;
}

function deleteRow_(table, id) {
  var sheet = getOrCreateSheet_(table, getDefaultHeaders_(table));
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === id) { sheet.deleteRow(i + 1); return true; }
  }
  return false;
}

function updateRow_(table, id, updates) {
  var sheet = getOrCreateSheet_(table, getDefaultHeaders_(table));
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      for (var key in updates) {
        var colIdx = headers.indexOf(key);
        if (colIdx >= 0) sheet.getRange(i + 1, colIdx + 1).setValue(updates[key]);
      }
      return true;
    }
  }
  return false;
}

function getDefaultHeaders_(table) {
  if (table === 'teachers') return ['code', 'name', 'pwHash', 'salt', 'createdAt'];
  if (table === 'answer_keys') return ['id', 'teacherCode', 'subject', 'unit', 'count', 'choices', 'questionsJson', 'createdAt'];
  if (table === 'submissions') return ['id', 'teacherCode', 'examId', 'name', 'subject', 'unit', 'count', 'correct', 'score', 'detailJson', 'submittedAt'];
  if (table === 'settings') return ['key', 'value'];
  return ['id'];
}


// ===== 도메인 헬퍼 =====
function findTeacher_(code) {
  var all = listAll_('teachers');
  for (var i = 0; i < all.length; i++) {
    if (all[i].code === code) return all[i];
  }
  return null;
}

function getExamById_(id, teacherCode) {
  var all = listAll_('answer_keys');
  for (var i = 0; i < all.length; i++) {
    if (all[i].id === id && all[i].teacherCode === teacherCode) {
      var it = all[i];
      it.questions = parseJson_(it.questionsJson) || [];
      return it;
    }
  }
  return null;
}

function findSubmissionById_(id, teacherCode) {
  var all = listAll_('submissions');
  for (var i = 0; i < all.length; i++) {
    if (all[i].id === id && all[i].teacherCode === teacherCode) return all[i];
  }
  return null;
}

function getSetting_(key, def) {
  var all = listAll_('settings');
  for (var i = 0; i < all.length; i++) {
    if (all[i].key === key) return all[i].value;
  }
  return def == null ? '' : def;
}

function setSetting_(key, value) {
  var sheet = getOrCreateSheet_('settings', ['key', 'value']);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function normalizeCode_(s) {
  return String(s || '').trim().toUpperCase().replace(/[^A-Z0-9\-_]/g, '');
}

function parseJson_(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

function jsonResp_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ===== 문항 유효성 검사 =====
function validateQuestions_(questions) {
  for (var i = 0; i < questions.length; i++) {
    var q = questions[i];
    if (q == null || typeof q !== 'object') {
      return { ok: false, error: (i + 1) + '번 문항 형식이 잘못되었습니다.' };
    }
    if (q.type === 'mc') {
      if (q.multi) {
        if (!Array.isArray(q.answers) || q.answers.length < 2) {
          return { ok: false, error: (q.q || (i+1)) + '번 복수정답 문항은 정답을 2개 이상 선택해야 합니다.' };
        }
        for (var k = 0; k < q.answers.length; k++) {
          var v = parseInt(q.answers[k]);
          if (!(v > 0)) {
            return { ok: false, error: (q.q || (i+1)) + '번 복수정답 항목이 유효하지 않습니다.' };
          }
          q.answers[k] = v;
        }
        q.answers = Array.from(new Set(q.answers)).sort(function(a,b){ return a-b; });
        delete q.answer;
      } else {
        if (q.answer == null || !(parseInt(q.answer) > 0)) {
          return { ok: false, error: (q.q || (i+1)) + '번 객관식 정답이 비어있습니다.' };
        }
        q.answer = parseInt(q.answer);
      }
    } else if (q.type === 'short') {
      if (!Array.isArray(q.answers) || q.answers.length === 0 ||
          !q.answers.some(function(a) { return String(a || '').trim() !== ''; })) {
        return { ok: false, error: (q.q || (i+1)) + '번 주관식 정답이 비어있습니다.' };
      }
    } else {
      return { ok: false, error: (q.q || (i+1)) + '번 문항 유형(type)을 알 수 없습니다.' };
    }
  }
  return { ok: true };
}


// ===== 인증 (토큰 방식) =====
function hashPassword_(password, salt) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    password + ':' + salt,
    Utilities.Charset.UTF_8
  );
  return raw.map(function(b) {
    var v2 = (b < 0 ? b + 256 : b).toString(16);
    return v2.length === 1 ? '0' + v2 : v2;
  }).join('');
}

function createToken_(code) {
  var secret = getSetting_('tokenSecret', 'default-secret');
  var exp = Date.now() + 1000 * 60 * 60 * 12;
  var payload = code + '|' + exp;
  var sig = hashPassword_(payload, secret).slice(0, 32);
  return Utilities.base64EncodeWebSafe(payload + '|' + sig);
}

function verifyToken_(token) {
  if (!token) return { ok: false };
  try {
    var dec = Utilities.newBlob(Utilities.base64DecodeWebSafe(token)).getDataAsString();
    var parts = dec.split('|');
    if (parts.length !== 3) return { ok: false };
    var code = parts[0], exp = parseInt(parts[1]), sig = parts[2];
    if (Date.now() > exp) return { ok: false };
    var secret = getSetting_('tokenSecret', 'default-secret');
    var expectedSig = hashPassword_(code + '|' + exp, secret).slice(0, 32);
    if (expectedSig !== sig) return { ok: false };
    return { ok: true, code: code };
  } catch (e) {
    return { ok: false };
  }
}


// ===== 채점 =====
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
