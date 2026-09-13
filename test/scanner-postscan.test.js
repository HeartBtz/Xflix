'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');

function load(file, overrides) {
  const filename = path.resolve(__dirname, '..', file);
  const native = createRequire(filename);
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  wrapper(name => Object.hasOwn(overrides, name) ? overrides[name] : native(name), module, module.exports, filename, path.dirname(filename));
  return module.exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const metadata = '{"format":{"duration":"1"},"streams":[]}';

function fixture(t, { videos = 0, thumbs = 0, probe, render, query, release } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xflix-postscan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Performer'));
  fs.writeFileSync(path.join(root, 'Performer', 'indexed.jpg'), 'photo');
  const source = path.join(root, '.source.mp4');
  fs.writeFileSync(source, 'video');
  process.env.MEDIA_DIR = root;
  process.env.THUMB_DIR = path.join(root, '.thumbs');
  const rows = Array.from({ length: Math.max(videos, thumbs) }, (_, index) => ({ id: index + 1, file_path: source, type: 'video' }));
  const calls = [];
  let held = false;
  const pool = {
    getConnection: async () => ({
      query: async sql => {
        calls.push(sql);
        if (sql.includes('GET_LOCK')) {
          if (held) return [[{ acquired: 0 }]];
          held = true;
          return [[{ acquired: 1 }]];
        }
        assert.match(sql, /RELEASE_LOCK/);
        if (release) await release();
        held = false;
        return [[{}]];
      },
      release() {},
    }),
    query: async (sql, params) => {
      assert.equal(held, true, 'all child queries must finish under the real maintenance wrapper');
      calls.push(sql);
      if (query) {
        const result = await query(sql, params);
        if (result !== undefined) return result;
      }
      if (sql.startsWith('SELECT') && sql.includes("type='video'")) return [rows.slice(0, videos).filter(row => row.id > params[0]).slice(0, params[1])];
      if (sql.startsWith('SELECT')) return [rows.slice(0, thumbs)];
      return [{ affectedRows: 1 }];
    },
  };
  const db = {
    pool, getAllExistingFilePaths: async () => new Map(), upsertPerformer: async () => 1,
    batchInsertMedia: async records => records.length, updatePerformerCounts: async () => {},
  };
  const maintenance = load('lib/maintenance.js', { '../db': db });
  const scanner = load('scanner.js', {
    './db': db, './lib/maintenance': maintenance,
    child_process: { execFile: (binary, args, options, callback) => {
      assert.equal(held, true);
      if (args.includes('-show_streams')) {
        if (probe) probe(callback); else callback(null, metadata);
      } else {
        fs.writeFileSync(args.at(-1), 'complete thumbnail');
        if (render) render(callback); else callback(null);
      }
    } },
  });
  return { scanner, db, maintenance, calls, held: () => held };
}

test('runScan keeps one lifecycle and local reservation through every phase and lock release', { timeout: 5000 }, async t => {
  const releasing = deferred(), finishRelease = deferred();
  const { scanner, calls, held } = fixture(t, { release: async () => { releasing.resolve(); await finishRelease.promise; } });
  const states = [];
  const work = scanner.runScan('all', progress => states.push(progress));
  assert.equal(scanner.getProgress().running, true, 'state is reserved before the first await');
  await releasing.promise;
  assert.equal(held(), true);
  assert.deepEqual(states.map(state => state.phase), ['index', 'index', 'index', 'enrich', 'thumbs']);
  assert.equal(states.every(state => state.running && !state.completed && state.finishedAt === null), true);
  assert.equal(states.every(state => typeof state.done === 'number' && !Object.hasOwn(state, 'indexed')), true);
  const duringRelease = scanner.getProgress();
  assert.equal(duringRelease.phase, 'thumbs');
  assert.equal(duringRelease.running, true);
  assert.equal(duringRelease.done, 1);
  await assert.rejects(scanner.runScan('photos'), { status: 409 });
  assert.deepEqual(scanner.getProgress(), duringRelease, 'rejected second scan cannot reset the owner state');
  finishRelease.resolve();
  const result = await work;
  assert.equal(held(), false);
  assert.equal(result.phase, 'done');
  assert.equal(result.running, false);
  assert.equal(result.completed, true);
  assert.equal(result.done, 1);
  assert.equal(Object.hasOwn(result, 'indexed'), false);
  assert.ok(result.finishedAt);
  assert.equal(calls.filter(sql => sql.includes('GET_LOCK')).length, 1);
  assert.deepEqual(states.at(-1), result);
});

test('enrichment cancellation drains started children but schedules no queued task or next page', { timeout: 5000 }, async t => {
  const ready = deferred();
  const children = [];
  let cancelled = false, settled = false;
  const { scanner, calls, held } = fixture(t, { videos: 8, probe: callback => {
    children.push(callback);
    if (children.length === 2) ready.resolve();
  } });
  const work = scanner.enrichDurations(2, () => cancelled).finally(() => { settled = true; });
  await ready.promise;
  cancelled = true;
  children[0](null, metadata);
  await tick();
  assert.equal(settled, false);
  assert.equal(held(), true);
  assert.equal(children.length, 2);
  children[1](null, metadata);
  await work;
  assert.equal(children.length, 2);
  assert.equal(calls.filter(sql => sql.startsWith('UPDATE')).length, 2);
  assert.equal(calls.filter(sql => sql.startsWith('SELECT id, file_path FROM media')).length, 1);
  assert.equal(held(), false);
});

test('cancellation at a page boundary prevents fetching the following page', { timeout: 5000 }, async t => {
  let cancelled = false, probes = 0;
  const { scanner, calls } = fixture(t, {
    videos: 2,
    probe: callback => { probes++; callback(null, metadata); },
    query: async (sql, params) => { if (sql.startsWith('UPDATE') && params.at(-1) === 2) cancelled = true; },
  });
  await scanner.enrichDurations(1, () => cancelled);
  assert.equal(probes, 2);
  assert.equal(calls.filter(sql => sql.startsWith('SELECT id, file_path FROM media')).length, 1);
});

test('pre-cancelled stages do no work, including cancellation while their SELECT is in flight', { timeout: 5000 }, async t => {
  for (const method of ['enrichDurations', 'generateMissingThumbs']) {
    const entered = deferred(), result = deferred();
    let cancelled = false, started = 0;
    const { scanner, calls } = fixture(t, {
      videos: 4, thumbs: 4,
      probe: () => { started++; }, render: () => { started++; },
      query: async sql => { if (sql.startsWith('SELECT')) { entered.resolve(); await result.promise; } },
    });
    await scanner[method](3, () => true);
    assert.deepEqual(calls, []);
    const work = scanner[method](3, () => cancelled);
    await entered.promise;
    cancelled = true;
    result.resolve();
    await work;
    assert.equal(started, 0);
    assert.equal(calls.filter(sql => sql.startsWith('SELECT id')).length, 1);
    await assert.rejects(scanner[method](3, true), /predicate/);
  }
});

test('cancelScan remains active during thumbnail generation and waits for all three children', { timeout: 5000 }, async t => {
  const ready = deferred(), children = [];
  let settled = false;
  const { scanner, held, calls } = fixture(t, { thumbs: 8, render: callback => {
    children.push(callback);
    if (children.length === 3) ready.resolve();
  } });
  const work = scanner.runScan('photos').finally(() => { settled = true; });
  await ready.promise;
  assert.equal(scanner.getProgress().phase, 'thumbs');
  assert.equal(scanner.getProgress().running, true);
  assert.equal(scanner.cancelScan(), true);
  assert.equal(scanner.getProgress().cancelled, true);
  assert.equal(scanner.getProgress().completed, false);
  assert.equal(scanner.getProgress().done, 1);
  children[0](null);
  children[1](null);
  await tick();
  assert.equal(settled, false);
  assert.equal(held(), true);
  children[2](null);
  const progress = await work;
  assert.equal(children.length, 3);
  assert.equal(calls.filter(sql => sql.startsWith('UPDATE')).length, 3);
  assert.equal(progress.phase, 'cancelled');
  assert.equal(progress.running, false);
  assert.equal(progress.completed, false);
  assert.equal(progress.done, 1);
  assert.ok(progress.finishedAt);
  assert.equal(scanner.cancelScan(), false);
});

test('external cancellation during enrichment skips queued probes and the entire thumbnail phase', { timeout: 5000 }, async t => {
  const ready = deferred(), children = [];
  let cancelled = false;
  const { scanner, calls } = fixture(t, { videos: 6, thumbs: 6, probe: callback => {
    children.push(callback);
    if (children.length === 3) ready.resolve();
  } });
  const work = scanner.runScan('all', null, () => cancelled);
  await ready.promise;
  cancelled = true;
  children.forEach(callback => callback(null, metadata));
  const progress = await work;
  assert.equal(progress.phase, 'cancelled');
  assert.equal(progress.completed, false);
  assert.equal(progress.done, 1);
  assert.equal(children.length, 3);
  assert.equal(calls.some(sql => sql.includes('thumb_path IS NULL')), false);
});

test('post-scan failure stops further tasks but drains siblings before final error state', { timeout: 5000 }, async t => {
  const ready = deferred(), failed = deferred(), children = [];
  const { scanner, held, calls } = fixture(t, {
    videos: 8, thumbs: 8,
    probe: callback => { children.push(callback); if (children.length === 3) ready.resolve(); },
    query: async sql => { if (sql.startsWith('UPDATE')) { failed.resolve(); throw new Error('metadata update failed'); } },
  });
  const work = scanner.runScan('all');
  const rejected = assert.rejects(work, /metadata update failed/);
  await ready.promise;
  children[0](null, metadata);
  await failed.promise;
  await tick();
  assert.equal(held(), true);
  assert.equal(scanner.getProgress().running, true);
  assert.equal(scanner.getProgress().phase, 'enrich');
  children[1](new Error('unprobeable'));
  children[2](new Error('unprobeable'));
  await rejected;
  assert.equal(children.length, 3);
  assert.equal(held(), false);
  const progress = scanner.getProgress();
  assert.equal(progress.phase, 'error');
  assert.equal(progress.lastError, 'metadata update failed');
  assert.equal(progress.errors, 1);
  assert.equal(progress.completed, false);
  assert.equal(progress.done, 1);
  assert.equal(progress.running, false);
  assert.equal(calls.some(sql => sql.includes('thumb_path IS NULL')), false);
});

test('a failed thumbnail render is an error, not a successful empty post-scan', { timeout: 5000 }, async t => {
  const { scanner } = fixture(t, { thumbs: 1, render: callback => callback(new Error('render failed')) });
  await assert.rejects(scanner.runScan('photos'), /Thumbnail generation failed for media 1/);
  const progress = scanner.getProgress();
  assert.equal(progress.phase, 'error');
  assert.equal(progress.running, false);
  assert.equal(progress.completed, false);
  assert.equal(progress.done, 1);
  assert.equal(progress.errors, 1);
});

for (const terminalPhase of ['error', 'cancelled']) test(`API polling exposes post-scan ${terminalPhase} rather than premature success`, { timeout: 5000 }, async t => {
  const entered = deferred(), fail = deferred();
  const { scanner, db } = fixture(t, { query: async sql => {
    if (sql.includes('thumb_path IS NULL')) { entered.resolve(); await fail.promise; }
  } });
  const pass = (req, res, next) => next();
  const router = load('routes/api.js', {
    '../scanner': scanner, '../db': db,
    '../middleware/auth': { requireContentAuth: pass, requireSameOrigin: pass, requireAdmin: pass },
  });
  const app = express();
  app.use(express.json(), router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const first = await fetch(`${base}/scan?mode=photos`, { method: 'POST' });
  assert.equal(first.status, 200);
  await first.json();
  await entered.promise;
  const active = await (await fetch(`${base}/scan/progress`)).json();
  assert.equal(active.running, true);
  assert.equal(active.phase, 'thumbs');
  assert.equal(active.completed, false);
  assert.equal(active.done, 1);
  assert.equal(Object.hasOwn(active, 'indexed'), false);
  assert.equal((await fetch(`${base}/scan`, { method: 'POST' })).status, 409);
  if (terminalPhase === 'error') fail.reject(new Error('thumbnail inventory failed'));
  else {
    assert.equal((await fetch(`${base}/scan/cancel`, { method: 'POST' })).status, 200);
    const cancelling = await (await fetch(`${base}/scan/progress`)).json();
    assert.equal(cancelling.running, true);
    assert.equal(cancelling.cancelled, true);
    fail.resolve();
  }
  while (scanner.getProgress().running) await tick();
  const terminal = await (await fetch(`${base}/scan/progress`)).json();
  assert.equal(terminal.running, false);
  assert.equal(terminal.phase, terminalPhase);
  assert.equal(terminal.completed, false);
  assert.equal(terminal.done, 1);
  assert.equal(Object.hasOwn(terminal, 'indexed'), false);
  assert.equal(terminal.errors, terminalPhase === 'error' ? 1 : 0);
  assert.equal(terminal.lastError, terminalPhase === 'error' ? 'thumbnail inventory failed' : null);
  assert.ok(terminal.finishedAt);
});

test('admin SSE preserves numeric done in progress and terminal status=done events', { timeout: 5000 }, async t => {
  const { scanner, db, maintenance } = fixture(t);
  const pass = (req, res, next) => next();
  const router = load('routes/admin.js', {
    '../scanner': scanner, '../db': db, '../lib/maintenance': maintenance,
    '../middleware/auth': { requireSameOrigin: pass, requireAdmin: pass },
    '../services/mail': {},
    '../lib/admin-media': {
      storageReady: async () => {},
      fail: (message, status) => Object.assign(new Error(message), { status }),
    },
  });
  const app = express();
  app.use(express.json(), router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/scan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'photos' }),
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const progress = events.filter(event => event.status === 'progress');
  assert.ok(progress.length);
  assert.equal(progress.every(event => typeof event.done === 'number' && !Object.hasOwn(event, 'indexed')), true);
  const terminal = events.at(-1);
  assert.equal(terminal.status, 'done');
  assert.equal(terminal.done, 1);
  assert.equal(terminal.completed, true);
  assert.equal(Object.hasOwn(terminal, 'indexed'), false);
});
