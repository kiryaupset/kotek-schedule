const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
const syncCode = script.slice(script.indexOf('    function parseNikaSchedule('), script.indexOf('    function parseSchoolInput('));
const hwCode = script.slice(script.indexOf('    let activeHw ='), script.indexOf('    function renderScheduleView()'));
const fixture = {
  CLASSES: { '018': '10а', '019': '10б' },
  CLASS_SCHEDULE: { '9': { '018': { '101': { s: ['old'] } } },
    '10': { '018': { '101': { s: ['math'], t: ['t'], r: ['r'] }, '114': { s: ['math'] } } } },
  SUBJECTS: { math: 'Алгебра', old: 'Старый предмет' },
  TEACHERS: { t: 'Учитель' }, ROOMS: { r: '13' }, LESSONSINDAY: 14
};
const dataFile = 'var NIKA = ' + JSON.stringify(fixture) + ';';

function context(fetch, { fullApp = false, initialStorage = [], confirm = () => true } = {}) {
  const storage = new Map(initialStorage);
  const elements = new Map();
  function element() {
    const children = [];
    return { value: '', style: {}, children, focus() {}, setAttribute() {}, appendChild(child) { children.push(child); },
      set innerHTML(value) { this.markup = value; children.length = 0; }, get innerHTML() { return this.markup; },
      querySelector: () => ({ addEventListener() {} }), classList: { add() {}, remove() {}, toggle() {} } };
  }
  const ctx = vm.createContext({
    fetch, AbortController, console, confirm, alert() {}, setInterval() {},
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30)), clearTimeout,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
      get length() { return storage.size; },
      key: index => [...storage.keys()][index] ?? null
    },
    document: { getElementById: id => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }, querySelectorAll: () => [], createElement: element },
    boySchedule: { original: true }, boyBells: [], renderDaySchedule() {}, updateRadar() {}
  });
  vm.runInContext(fullApp ? script : syncCode + hwCode, ctx);
  return { ctx, storage, elements, run: code => vm.runInContext(code, ctx),
    field: (id, value) => { ctx.document.getElementById(id).value = value; } };
}
const response = text => ({ ok: true, text: async () => text, json: async () => JSON.parse(text) });

test('school JSON format: class, numeric periods, dictionaries and lesson 14', () => {
  const c = context();
  c.ctx.code = dataFile;
  c.run('parseNikaSchedule(decodeNikaData(code))');
  const saved = JSON.parse(c.storage.get('nk_boy_sched'));
  assert.equal(saved[0][0].subject, 'Алгебра');
  assert.equal(saved[0][0].sub, 'Учитель • Каб. 13');
  assert.equal(saved[0][1].num, 14);
  assert.throws(() => c.run('decodeNikaData("<html>blocked</html>")'));
  c.ctx.empty = { ...fixture, CLASS_SCHEDULE: { '10': { '018': {} } } };
  assert.throws(() => c.run('parseNikaSchedule(empty)'));
  assert.equal(JSON.parse(c.storage.get('nk_boy_sched'))[0][0].subject, 'Алгебра');
});

test('proxy race skips HTTP-200 error pages and unwraps AllOrigins JSON', async () => {
  const c = context(async url => response(url.includes('allorigins')
    ? JSON.stringify({ contents: '17407888_20261030203219.js', status: { http_code: 200 } })
    : '<!doctype html>Proxy error'));
  const value = await c.run('fetchViaProxies("https://school/check", text => /^17407888_\\d+\\.js$/.test(text))');
  assert.equal(value, '17407888_20261030203219.js');
});

test('hung requests time out and report failure', async () => {
  const c = context((url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  await assert.rejects(c.run('fetchViaProxies("https://school/check")'), /Все прокси/);
});

test('sync discovers current file, falls back to HTML and prevents duplicate runs', async () => {
  let files = 0;
  const c = context(async url => {
    if (url.includes('/check/')) throw new Error('check unavailable');
    if (!url.startsWith('https://proxy.cors.dev/')) throw new Error('proxy unavailable');
    if (url.includes('/static/public/')) { files++; return response(dataFile); }
    return response('<script src="/static/public/17407888_20261030203219.js"></script>');
  });
  await Promise.all([c.run('syncSchoolSchedule()'), c.run('syncSchoolSchedule()')]);
  assert.equal(files, 1);
  assert.equal(JSON.parse(c.storage.get('nk_boy_sched'))[0][0].subject, 'Алгебра');
  assert.match(c.elements.get('school-msg').textContent, /успешно/);
});

test('failed sync preserves saved schedule', async () => {
  const c = context(async () => response('<!doctype html>Service unavailable'));
  c.storage.set('nk_boy_sched', 'original');
  await c.run('syncSchoolSchedule()');
  assert.equal(c.storage.get('nk_boy_sched'), 'original');
  assert.match(c.elements.get('school-msg').textContent, /^Ошибка:/);
});

test('homework reset for one lesson is staged and hides legacy homework only for the chosen date', () => {
  const c = context(undefined, { fullApp: true, initialStorage: [['nk_hw_boy_0_1', 'Старое ДЗ'], ['nk_chk_boy_0_1', '1']] });
  c.run('openSchedule("boy"); selectScheduleDate("2026-11-16"); toggleHomeworkEditor(); openHwModal(getBaseLessons("boy", 0)[0])');
  assert.equal(c.elements.get('hw-modal-text').value, 'Старое ДЗ');
  assert.equal(c.elements.get('hw-modal-chk').checked, true);
  c.run('resetHwModal()');
  assert.equal(c.storage.has('nk_hw_boy_2026-11-16'), false);
  c.run('applyHomeworkDraft()');
  assert.equal(c.run('readHomework("boy", selectedDate, getBaseLessons("boy", 0)[0]).text'), '');
  assert.equal(c.run('readHomework("boy", selectedDate, getBaseLessons("boy", 0)[0]).done'), false);
  c.run('selectScheduleDate("2026-11-23")');
  assert.equal(c.run('readHomework("boy", selectedDate, getBaseLessons("boy", 0)[0]).text'), 'Старое ДЗ');
});

test('manual replacements survive reload and affect only their date and class', () => {
  const c = context(undefined, { fullApp: true });
  c.field('manual-target-sel', 'girl');
  c.field('manual-mode-sel', 'date');
  c.field('manual-date', '2026-11-18');
  c.run('renderManualEditor()');
  const base = c.run('getBaseLessons("girl", 2)[0].subject');
  c.field('med_subj_0', 'Новая пара');
  c.run('addManualLessonRow()');
  assert.equal(c.run('manualLessons[0].subject'), 'Новая пара');
  assert.equal(c.run('getBaseLessons("girl", 2)[0].subject'), base);
  c.run('saveManualSchedule()');

  const reloaded = context(undefined, { fullApp: true, initialStorage: c.storage });
  const subject = (target, date) => reloaded.run(`getLessonsForDate('${target}', new Date('${date}T12:00:00'))[0].subject`);
  assert.equal(subject('girl', '2026-11-18'), 'Новая пара');
  assert.equal(subject('girl', '2026-11-25'), base);
  assert.notEqual(subject('boy', '2026-11-18'), 'Новая пара');

  reloaded.field('manual-target-sel', 'girl');
  reloaded.field('manual-mode-sel', 'date');
  reloaded.field('manual-date', '2026-11-18');
  reloaded.run('renderManualEditor(); while (manualLessons.length) removeManualLessonRow(0); saveManualSchedule()');
  assert.equal(reloaded.run('getLessonsForDate("girl", new Date(2026, 10, 18)).length'), 0);
  reloaded.run('removeDayReplacement()');
  assert.equal(subject('girl', '2026-11-18'), base);
});

test('school exchanges apply on their own dates without mutating the recurring schedule', () => {
  const c = context(undefined, { fullApp: true });
  c.ctx.data = { ...fixture, CLASS_EXCHANGE: { '018': { '16.11.2026': { 1: { s: ['old'] }, 14: { s: 'F' } } } } };
  c.run('parseNikaSchedule(data); selectScheduleDate("2026-11-18"); selectDay(0)');
  assert.equal(c.elements.get('sched-date').value, '2026-11-16');
  assert.match(c.run('getLessonsForDate("boy", selectedDate)[0].subject'), /Старый предмет/);
  assert.match(c.run('getLessonsForDate("boy", selectedDate)[1].subject'), /ОТМЕНЕН/);
  c.run('selectScheduleDate("2026-11-23")');
  assert.equal(c.run('getLessonsForDate("boy", selectedDate)[0].subject'), 'Алгебра');
  assert.equal(JSON.parse(c.storage.get('nk_boy_sched'))[0][0].subject, 'Алгебра');
});

test('global homework reset needs confirmation and preserves other settings', () => {
  let approved = false;
  const c = context(undefined, { confirm: () => approved });
  const homeworkKeys = ['nk_hw_boy_0_1', 'nk_chk_girl_0_1', 'nk_hw_girl_2026-11-18_2', 'nk_hw_boy_2026-11-18'];
  const otherKeys = ['nk_boy_sched', 'nk_day_replacements', 'gemini_api_key'];
  for (const key of [...homeworkKeys, ...otherKeys]) c.storage.set(key, 'value');
  c.run('resetAllHomework()');
  assert.ok(homeworkKeys.every(key => c.storage.has(key)));
  approved = true;
  c.run('resetAllHomework()');
  assert.ok(homeworkKeys.every(key => !c.storage.has(key)));
  assert.ok(otherKeys.every(key => c.storage.has(key)));
});

test('one-day photo import applies substitutions, cancellations and full lists only to the chosen date', async () => {
  const key = '2026-11-18';
  const base = { 2: [{ num: 1, subject: 'Физика' }, { num: 2, subject: 'История' }, { num: 3, subject: 'Русский' }] };
  let result = { type: 'changes', lessons: [{ num: 1, subject: 'Алгебра' }, { num: 2, cancelled: true }] };
  const c = context(async (url, { body }) => {
    const request = JSON.parse(body);
    assert.match(request.contents[0].parts[0].text, /2026-11-18 \(Среда\)/);
    return { json: async () => ({ candidates: [{ content: { parts: [
      { text: 'internal reasoning', thought: true }, { text: JSON.stringify(result) }
    ] } }] }) };
  }, { fullApp: true, initialStorage: [['gemini_api_key', 'test'], ['nk_boy_sched', JSON.stringify(base)]] });
  c.ctx.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,eA=='; this.onload(); }
  };
  c.field('photo-mode-sel', 'date');
  c.field('photo-date', key);
  c.field('photo-target-sel', 'boy');
  c.field('photo-file-field', 'test.png');
  c.elements.get('photo-file-field').files = [{ type: 'image/png' }];

  const saved = () => JSON.parse(c.storage.get('nk_day_replacements')).boy[key];
  await c.run('parseSchedulePhoto()');
  assert.deepEqual(saved().map(row => row.subject), ['Алгебра', 'Русский']);
  assert.deepEqual(JSON.parse(c.storage.get('nk_boy_sched')), base);
  assert.equal(c.run('getLessonsForDate("boy", new Date(2026, 10, 25)).length'), 3);
  assert.match(c.elements.get('photo-msg').textContent, /18\.11\.2026/);

  result = { type: 'full', lessons: [{ num: 2, subject: 'География' }] };
  await c.run('parseSchedulePhoto()');
  assert.deepEqual(saved().map(row => row.subject), ['География']);

  result = { type: 'changes', lessons: [{ num: 2, subject: 'Химия' }, { num: 2, subject: 'Литература' }] };
  await c.run('parseSchedulePhoto()');
  assert.deepEqual(saved().map(row => row.subject), ['География']);
  assert.match(c.elements.get('photo-msg').textContent, /^Ошибка:/);
});

test('a Gemini network error falls back to local OCR and rejects a mismatched date', async () => {
  const c = context(async () => { throw new TypeError('Failed to fetch'); }, {
    fullApp: true, initialStorage: [['gemini_api_key', 'test']]
  });
  const file = { type: 'image/png' };
  c.ctx.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,eA=='; this.onload(); }
  };
  let ocrCalls = 0;
  c.ctx.Tesseract = {
    PSM: { SINGLE_BLOCK: '6' },
    createWorker: async () => ({
      setParameters: async () => {},
      terminate: async () => {},
      recognize: async image => {
        assert.equal(image, file);
        ocrCalls++;
        return { data: { text: 'Замены 12.11.2026 (Четверг)\nГруппа: 16д3.\n* 1. Физика Иванова А.А.\nОсновной корпус-\nАудитория 120\n* 2. Отмена\n14:34' } };
      }
    })
  };
  c.field('photo-mode-sel', 'date');
  c.field('photo-date', '2026-11-12');
  c.field('photo-target-sel', 'girl');
  c.field('photo-file-field', 'test.png');
  c.elements.get('photo-file-field').files = [file];

  await c.run('parseSchedulePhoto()');
  const saved = c.storage.get('nk_day_replacements');
  const lessons = JSON.parse(saved).girl['2026-11-12'];
  assert.equal(ocrCalls, 1);
  assert.deepEqual(lessons[0], { num: 1, subject: 'Физика', sub: 'Иванова А.А. Основной корпус — Аудитория 120' });
  assert.ok(!lessons.some(lesson => lesson.num === 2));
  assert.match(c.elements.get('photo-msg').textContent, /распознана и применена/);

  c.field('photo-date', '2026-11-19');
  await c.run('parseSchedulePhoto()');
  assert.equal(c.storage.get('nk_day_replacements'), saved);
  assert.match(c.elements.get('photo-msg').textContent, /Проверь выбранную дату/);
});

function openHomeworkPhoto(c) {
  c.ctx.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,eA=='; this.onload(); }
  };
  c.run('openSchedule("boy"); selectScheduleDate("2026-11-13"); toggleHomeworkEditor()');
  c.elements.get('hw-photo-file').files = [{ type: 'image/png' }];
}

const fridayLessons = JSON.stringify({ 4: [
  { num: 1, subject: 'Алг. и нач.мат.анализа' }, { num: 2, subject: 'Алг. и нач.мат.анализа' },
  { num: 3, subject: 'История' }, { num: 4, subject: 'Физика' }
] });

test('a homework photo stages matched lessons and applies changes to one date only', async () => {
  const c = context(async (url, { body }) => {
    assert.match(JSON.parse(body).contents[0].parts[0].text, /2026-11-13/);
    const result = { date: '2026-11-13', assignments: [
      { subject: 'Алгебра', text: '№ 105' }, { subject: 'История', text: '§ 4', num: 3 },
      { subject: 'География', text: 'Карта' }, { subject: 'Физика', text: 'Лабораторная', num: 3 }
    ] };
    return { json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] }) };
  }, { fullApp: true, initialStorage: [['gemini_api_key', 'test'], ['nk_boy_sched', fridayLessons]] });
  openHomeworkPhoto(c);
  const list = c.elements.get('lessons-render-target');
  assert.ok(list.children.every(row => row.innerHTML.includes('pencil-btn')));
  await c.run('importHomeworkPhoto()');
  assert.equal(c.storage.has('nk_hw_boy_2026-11-13'), false);
  assert.match(c.elements.get('hw-edit-msg').textContent, /Пропущено записей без совпадения: 2/);
  assert.match(list.children[0].innerHTML, /№ 105/);
  c.run('applyHomeworkDraft()');
  const saved = JSON.parse(c.storage.get('nk_hw_boy_2026-11-13'));
  assert.deepEqual(Object.keys(saved), ['1', '3']);
  assert.equal(saved[3].text, '§ 4');
  assert.ok(list.children.every(row => !row.innerHTML.includes('pencil-btn')));
  c.run('selectScheduleDate("2026-11-20")');
  assert.ok(list.children.every(row => !row.innerHTML.includes('№ 105')));
});

test('homework uses local OCR if Gemini fails and rejects a different date', async () => {
  const c = context(async () => { throw new TypeError('Failed to fetch'); }, {
    fullApp: true, initialStorage: [['gemini_api_key', 'test'], ['nk_boy_sched', fridayLessons]]
  });
  c.ctx.Tesseract = {
    PSM: { SINGLE_BLOCK: '6' },
    createWorker: async () => ({
      setParameters: async () => {}, terminate: async () => {},
      recognize: async () => ({ data: { text: 'Пятница, 13.11\nАлгебра\nРешить № 105\nИстория: § 4\nГеография: карта\nФизика: § 8' } })
    })
  };
  openHomeworkPhoto(c);
  await c.run('importHomeworkPhoto()');
  c.run('applyHomeworkDraft()');
  const saved = JSON.parse(c.storage.get('nk_hw_boy_2026-11-13'));
  assert.deepEqual(Object.values(saved).map(row => row.text), ['Решить № 105', '§ 4', '§ 8']);

  c.run('selectScheduleDate("2026-11-20"); toggleHomeworkEditor()');
  c.elements.get('hw-photo-file').files = [{ type: 'image/png' }];
  await c.run('importHomeworkPhoto()');
  assert.match(c.elements.get('hw-edit-msg').textContent, /Дата на фото отличается/);
  assert.equal(c.run('homeworkDraft.changes.size'), 0);
});

test('changing the day while a homework photo is being read discards the stale result', async () => {
  let complete;
  const c = context(() => new Promise(resolve => { complete = resolve; }), {
    fullApp: true, initialStorage: [['gemini_api_key', 'test'], ['nk_boy_sched', fridayLessons]]
  });
  openHomeworkPhoto(c);
  const pending = c.run('importHomeworkPhoto()');
  await Promise.resolve();
  assert.equal(typeof complete, 'function');
  c.run('selectScheduleDate("2026-11-20")');
  complete({ json: async () => ({ candidates: [{ content: { parts: [{ text: '{"assignments":[{"subject":"История","text":"§ 4"}]}' }] } }] }) });
  await pending;
  assert.equal(c.run('homeworkDraft.changes.size'), 0);
  assert.equal(c.run('homeworkDraft.key'), '2026-11-20');
  assert.equal(c.storage.has('nk_hw_boy_2026-11-13'), false);
});
