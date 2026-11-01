const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
const syncCode = script.slice(script.indexOf('    function parseNikaSchedule('), script.indexOf('    function parseSchoolInput('));
const hwCode = script.slice(script.indexOf('    let activeHw ='), script.indexOf('    // Отрисовка списка:'));
const fixture = {
  CLASSES: { '018': '10а', '019': '10б' },
  CLASS_SCHEDULE: { '9': { '018': { '101': { s: ['old'] } } },
    '10': { '018': { '101': { s: ['math'], t: ['t'], r: ['r'] }, '114': { s: ['math'] } } } },
  SUBJECTS: { math: 'Алгебра', old: 'Старый предмет' },
  TEACHERS: { t: 'Учитель' }, ROOMS: { r: '13' }, LESSONSINDAY: 14
};
const dataFile = 'var NIKA = ' + JSON.stringify(fixture) + ';';

function context(fetch) {
  const storage = new Map();
  const elements = new Map();
  const ctx = vm.createContext({
    fetch, AbortController, console,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30)), clearTimeout,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    document: { getElementById: id => {
      if (!elements.has(id)) elements.set(id, { style: {}, focus() {}, classList: { add() {}, remove() {} } });
      return elements.get(id);
    } },
    boySchedule: { original: true }, boyBells: [], renderDaySchedule() {}, updateRadar() {}
  });
  vm.runInContext(syncCode + hwCode, ctx);
  return { ctx, storage, elements, run: code => vm.runInContext(code, ctx) };
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

test('homework reset only clears the selected lesson and its completion flag', () => {
  const c = context();
  for (const key of ['nk_hw_boy_0_1', 'nk_chk_boy_0_1', 'nk_hw_girl_0_1', 'nk_hw_boy_0_2']) c.storage.set(key, 'keep');
  c.run("openHwModal('boy', 0, 1, 'Алгебра'); resetHwModal()");
  assert.equal(c.storage.has('nk_hw_boy_0_1'), false);
  assert.equal(c.storage.has('nk_chk_boy_0_1'), false);
  assert.equal(c.storage.get('nk_hw_girl_0_1'), 'keep');
  assert.equal(c.storage.get('nk_hw_boy_0_2'), 'keep');
});
