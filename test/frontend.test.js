'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readEvents } = require('../public/js/stream-events');

function app() {
  const elements = new Map(), listeners = new Map();
  function element(id = '') {
    const classes = new Set(['hidden']);
    const el = { id, value: '', innerHTML: '', textContent: '', dataset: {}, style: {}, options: [],
      classList: { add: (...cs) => cs.forEach(c => classes.add(c)), remove: (...cs) => cs.forEach(c => classes.delete(c)),
        contains: c => classes.has(c), toggle: (c, force = !classes.has(c)) => { force ? classes.add(c) : classes.delete(c); return force; } },
      addEventListener: (event, callback) => listeners.set(`${id}:${event}`, callback),
      querySelectorAll: () => [], querySelector: () => null,
      setAttribute() {}, getAttribute: () => null, removeAttribute() {}, contains: () => false,
      load() {}, pause() {}, play: async () => {}, appendChild() {}, focus() {},
    };
    return el;
  }
  const document = { getElementById: id => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  }, querySelectorAll: () => [], querySelector: () => null,
  createElement: () => element(), addEventListener: (type, cb) => {
    const key = `document:${type}`;
    listeners.set(key, [...(listeners.get(key) || []), cb]);
  }, body: { style: {} } };
  const sandbox = { document, console, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: fn => fn(), HTMLImageElement: class {}, Image: class {},
    IntersectionObserver: class { observe() {} unobserve() {} },
    localStorage: { getItem: () => null, setItem() {} },
    history: { state: { page: 'home' }, replaceState(s) { this.state = s; }, pushState(s) { this.state = s; } },
    fetch: async () => { throw new Error('Unexpected network'); },
    window: { XflixNavigation: require('../public/js/navigation-state'), addEventListener() {}, scrollTo() {} },
  };
  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8').replace(/bootstrap\(\);\s*$/, '');
  vm.runInContext(source, context);
  return { context, elements, listeners, run: code => vm.runInContext(code, context) };
}

function admin() {
  const a = app();
  a.context.window.XflixStreams = { readEvents };
  a.context.confirm = () => true;
  a.context.alert = () => {};
  a.context.setTimeout = () => 1;
  const source = fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8')
    .replace(/boot\(\)\.catch\([^\n]+\);/, 'window.adminTest = { apiFetch, loadSettings };');
  vm.runInContext(source, a.context);
  return a;
}

test('escapeHtml escapes text and both attribute quotes, including null', () => {
  const a = app();
  assert.equal(a.context.escapeHtml('<"\'&>'), '&lt;&quot;&#39;&amp;&gt;');
  assert.equal(a.context.escapeHtml(null), '');
  assert.match(a.context.renderSingleVideoCard({ id: 1, filename: '" autofocus data-x="evil' }), /&quot; autofocus/);
});

test('request guards reject older requests, navigation, sessions and media changes', () => {
  const a = app();
  const first = a.context.requestGuard('list');
  const second = a.context.requestGuard('list');
  assert.equal(first(), false); assert.equal(second(), true);
  a.run('baseEpoch++'); assert.equal(second(), false);
  const social = a.context.requestGuard('social', true);
  a.run('mediaEpoch++'); assert.equal(social(), false);
  const session = a.context.requestGuard('profile');
  a.run('sessionEpoch++'); assert.equal(session(), false);
});

test('older performer search response cannot replace newer results', async () => {
  const a = app();
  let resolveOld;
  a.context.apiFetch = url => url.includes('q=old') ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve({ data: [{ name: 'new' }], total: 1 });
  a.context.renderPerformers = () => {};
  a.context.renderPagination = () => {};
  const old = a.context.loadPerformers({ q: 'old' });
  await a.context.loadPerformers({ q: 'new' });
  resolveOld({ data: [{ name: 'old' }], total: 1 }); await old;
  assert.equal(a.run('state.performers[0].name'), 'new');
});

test('performer 404 clears previous state and never loads its media', async () => {
  const a = app();
  a.run('state.currentPerformer = { name: "old" }; state.videos = [{id: 1}];');
  let calls = 0;
  a.context.apiFetch = async () => { calls++; throw new Error('404'); };
  await a.context.openPerformer('missing', { fromHistory: true });
  assert.equal(a.run('state.currentPerformer'), null);
  assert.equal(a.run('state.videos.length'), 0);
  assert.equal(calls, 1);
});

test('navigation back during a pending base render restores the requested page', async () => {
  const a = app(); let finish;
  a.context.apiFetch = url => url.includes('/performers/Slow') ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve({ data: [], total: 0 });
  a.context.renderPerformers = () => {};
  a.context.renderPagination = () => {};
  const old = a.context.renderRoute({ page: 'performer', name: 'Slow' });
  await a.context.renderRoute({ page: 'home' });
  finish({ id: 2, name: 'Slow' }); await old;
  assert.equal(a.run('state.currentPage'), 'home');
  assert.equal(a.run('state.currentPerformer'), null);
});

test('late social response cannot change another media favorite', async () => {
  const a = app(); let finish;
  a.run('auth.user = {id: 1};');
  const button = a.context.document.getElementById('favCurrentVideo');
  button.dataset.id = '11';
  a.context.apiFetch = () => new Promise(resolve => { finish = resolve; });
  const old = a.context.loadPersonalFavorite(11, button);
  a.run('mediaEpoch++'); button.dataset.id = '12'; button.textContent = 'new';
  finish({ favorited: true }); await old;
  assert.equal(button.textContent, 'new');
});

test('failed comments pagination can retry the same page', async () => {
  const a = app(); const urls = [];
  a.run('commentsPage = 1;');
  a.context.apiFetch = async url => { urls.push(url); throw new Error('500'); };
  await a.context.loadComments(11, false);
  await a.context.loadComments(11, false);
  assert.match(urls[0], /page=2/); assert.equal(urls[0], urls[1]);
  assert.equal(a.run('commentsPage'), 1);
});

test('scan polling reports terminal errors and re-enables both cancel controls', async () => {
  const a = app(); let poll, toast;
  a.context.setInterval = callback => { poll = callback; return 1; };
  a.context.clearInterval = () => {};
  a.context.apiFetch = async () => ({ running: false, total: 10, done: 8, errors: 2 });
  a.context.loadHeroStats = () => {};
  a.context.loadPerformers = () => {};
  a.context.showToast = (message, type) => { toast = type; };
  a.context.document.getElementById('scanBannerCancel').disabled = true;
  a.context.startScanPolling();
  await poll();
  assert.equal(toast, 'error');
  assert.equal(a.context.document.getElementById('scanBannerCancel').disabled, false);
  assert.equal(a.context.document.getElementById('btnCancelScan').disabled, false);
  assert.equal(a.run('state.scanInterval'), null);
});

for (const running of [false, true, 'true', null]) {
  test(`scan POST 409 starts polling only on confirmed running=true (${running})`, async () => {
    const a = app(); let polled = false, message, calls = 0;
    a.context.apiPost = async () => { throw Object.assign(new Error('Maintenance busy'), { status: 409 }); };
    a.context.apiFetch = async url => {
      assert.equal(url, '/api/scan/progress'); calls++;
      return { running, total: 10, done: 10 }; // Previous completed scan is not a new success.
    };
    a.context.startScanPolling = () => { polled = true; };
    a.context.showToast = (text, type) => { message = { text, type }; };
    await a.context.launchScan('all');
    assert.equal(calls, 1);
    assert.equal(polled, running === true);
    if (running !== true) {
      assert.equal(message.type, 'error'); assert.match(message.text, /Maintenance busy/);
      assert.equal(a.context.document.getElementById('btnScanAll').disabled, false);
    } else assert.equal(message, undefined);
  });
}

test('scan conflict with unavailable progress fails without polling', async () => {
  const a = app(); let message;
  a.context.apiPost = async () => { throw Object.assign(new Error('Maintenance busy'), { status: 409 }); };
  a.context.apiFetch = async () => { throw new Error('Network unavailable'); };
  a.context.startScanPolling = () => assert.fail('Must not poll an unverified scan');
  a.context.showToast = (text, type) => { message = type; };
  await a.context.launchScan('all');
  assert.equal(message, 'error');
});

test('admin HTTP errors preserve structured recovery fields, including deleted=null', async () => {
  const a = admin();
  const details = { error: 'Commit unknown', deleted: null, recovery_required: true, operation_id: 'fixture-recovery' };
  a.context.fetch = async () => new Response(JSON.stringify(details), { status: 500 });
  await assert.rejects(a.context.window.adminTest.apiFetch('/admin/media/11'), error => {
    assert.equal(error.message, details.error); assert.equal(error.status, 500);
    for (const key of ['deleted', 'recovery_required', 'operation_id']) assert.equal(error[key], details[key]);
    return true;
  });
});

for (const committed of [null, 0, 1]) {
  test(`manual delete counts prior commits and preserves HTTP recovery outcome (${committed})`, async () => {
    const a = admin(), removed = [];
    const checkboxes = [11, 12].map(id => ({ dataset: { id }, closest: () => ({ remove: () => removed.push(id) }) }));
    a.context.document.getElementById('mbGrid').querySelectorAll = () => checkboxes;
    a.context.fetch = async url => url.endsWith('/11') ? new Response('{"deleted":1}')
      : new Response(JSON.stringify({ error: 'Finalization failed', deleted: committed, recovery_required: true, operation_id: 'fixture-op' }), { status: 500 });
    await a.listeners.get('mbDeleteBtn:click')();
    const label = a.context.document.getElementById('mbLabel').textContent;
    assert.match(label, new RegExp(`${committed === 1 ? 2 : 1} / 2 suppression`));
    assert.match(label, /fixture-op/);
    assert.match(label, /vérification serveur requise/);
    assert.equal(label.includes('état incertain'), committed === null);
    assert.deepEqual(removed, committed === 1 ? [11, 12] : [11]);
  });
}

test('SMTP save reloads server state instead of claiming the old secret remains', async () => {
  const a = admin(), requests = [];
  let saved = false;
  a.context.fetch = async (url, options) => {
    requests.push(options.method || 'GET');
    if (options.method === 'PUT') {
      assert.equal(Object.hasOwn(JSON.parse(options.body), 'smtp_pass'), false);
      saved = true; return new Response('{}');
    }
    return new Response(JSON.stringify({ smtp_host: saved ? 'new.invalid' : 'old.invalid', smtp_pass: saved ? '' : 'masked', smtp_user: 'fixture' }));
  };
  await a.context.window.adminTest.loadSettings();
  a.context.document.getElementById('smtpHost').value = 'new.invalid';
  await a.listeners.get('saveSmtpBtn:click')();
  assert.deepEqual(requests, ['GET', 'PUT', 'GET']);
  assert.equal(a.context.document.getElementById('smtpPass').placeholder, 'Aucun secret configuré');
  assert.match(a.context.document.getElementById('smtpTestResult').textContent, /sauvegardé sans secret/);
});

test('infinite scroll commits page only after success and preserves existing cards', async () => {
  const a = app();
  a.run('state.currentPerformer = { name: "A" }; state.videoPage = 1; state.videos = [{id: 1}];');
  a.context.showToast = () => {};
  a.context.apiFetch = async () => { throw new Error('500'); };
  await a.context.loadVideos(2, true);
  assert.equal(a.run('state.videoPage'), 1);
  assert.equal(a.run('state.videos.length'), 1);
  a.context.apiFetch = async () => ({ data: [], total: 1 });
  a.context.renderPagination = () => {};
  await a.context.loadVideos(2, true);
  assert.equal(a.run('state.videoPage'), 2);
  assert.equal(a.run('state.videos.length'), 1);
});

test('personal favorites are paginated and supply video and photo playlists', async () => {
  const a = app(); let url;
  a.run('auth.user = {id: 1};');
  a.context.apiFetch = async u => { url = u; return { data: [{id: 11, type: 'video', filename: 'A'}, {id: 12, type: 'photo', filename: 'B'}], total: 125, limit: 60 }; };
  let pagination;
  a.context.renderPagination = (...args) => { pagination = args; };
  await a.context.loadMyFavorites(2);
  assert.match(url, /page=2/);
  assert.equal(a.run('state.videos[0].id'), 11);
  assert.equal(a.run('state.photos[0].id'), 12);
  assert.equal(pagination[2], 3);
});

test('resume uses active media identity, not a replaced playlist index', async () => {
  const a = app();
  a.run('activeVideoId = 11; state.videos = [{id: 99}]; state.videoIndex = 0;');
  a.context.document.getElementById('videoPlayer').currentTime = 42;
  await a.context.teardownVideoModal();
  assert.equal(a.run('resumeMap[11]'), 42);
  assert.equal(a.run('resumeMap[99]'), undefined);
});

test('keyboard shortcuts leave editable targets and native controls alone', () => {
  const a = app();
  a.elements.get('videoModal').classList.remove('hidden');
  for (const key of [' ', 'f', 'm', 'p', 'd', '1', 'ArrowLeft', 'Enter']) {
    for (const callback of a.listeners.get('document:keydown')) {
      callback({ key, target: { closest: selector => selector.includes('textarea') ? {} : null },
        preventDefault() { assert.fail('Editable key intercepted'); } });
    }
  }
});

test('API rejects every non-2xx and retries only temporary failures', async () => {
  const a = app();
  for (const status of [300, 400, 403, 404, 409, 429, 500, 503]) {
    a.context.fetch = async () => new Response('{"error":"rejected"}', { status });
    await assert.rejects(a.context.apiFetch('/mock', 1), /rejected/);
  }
  let calls = 0;
  a.context.fetch = async () => ++calls === 1 ? new Response('{}', { status: 503 }) : new Response('{"ok":true}');
  assert.equal((await a.context.apiFetch('/mock', 2, 0)).ok, true);
  assert.equal(calls, 2);
});

function sse(text, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
async function collect(response) { const events = []; for await (const event of readEvents(response)) events.push(event); return events; }

test('SSE handles split UTF-8, CRLF, heartbeats and final unterminated line', async () => {
  const events = await collect(sse(': ping\r\ndata: {"status":"progress","line":"caf\u00e9"}\r\n\r\ndata: {"status":"done"}', 1));
  assert.equal(events[0].line, 'caf\u00e9'); assert.equal(events[1].status, 'done');
});
for (const [name, text] of [
  ['final error', 'data: {"status":"error","error":"failed"}\n'],
  ['EOF', 'data: {"status":"progress"}\n'],
  ['malformed event', 'data: broken\n'],
  ['partial errors array', 'data: {"status":"done","errors":[{"error":"failed"}]}\n'],
  ['partial errors count', 'data: {"status":"done","errors":2}\n'],
  ['item error', 'data: {"status":"error_item","error":"failed"}\ndata: {"status":"done"}\n'],
  ['cancelled', 'data: {"status":"done","cancelled":true}\n'],
  ['error after done', 'data: {"status":"done"}\ndata: {"status":"error"}\n'],
]) test(`SSE never reports success on ${name}`, async () => {
  const seen = [];
  await assert.rejects(async () => { for await (const d of readEvents(sse(text))) seen.push(d); });
  assert.equal(seen.some(d => d.status === 'done'), false);
});
test('SSE rejects HTTP errors and unexpected JSON responses', async () => {
  await assert.rejects(collect(new Response('{}', { status: 500 })), /500/);
  await assert.rejects(collect(new Response('{}', { headers: { 'Content-Type': 'application/json' } })), /SSE/);
});
test('SSE preserves partial-operation warnings and recovery reference', async () => {
  await assert.rejects(collect(sse('data: {"status":"error","error":"Failed","recovery_required":true,"operation_id":"fixture-op"}\n')),
    /verification serveur requise.*fixture-op/);
});

test('fixture helper is safe under default test discovery', () => {
  require('./frontend-server');
});

test('fixture server accepts port 0 and reports its ephemeral listening port', { timeout: 10000 }, async t => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const child = spawn(process.execPath, [path.join(__dirname, 'frontend-server.js'), '--serve', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
  });
  const [output] = await once(child.stdout, 'data');
  const match = output.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
  assert.ok(match, output.toString());
  assert.ok(Number(match[1]) > 0);
  assert.notEqual(Number(match[1]), 18765);
  const response = await fetch(match[0]);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>XFlix<\/title>/);
});
