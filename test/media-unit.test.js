'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

function load(file, overrides = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const native = createRequire(filename);
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  wrapper(name => Object.hasOwn(overrides, name) ? overrides[name] : native(name), module, module.exports, filename, path.dirname(filename));
  return module.exports;
}

let root;
test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xflix-media-unit-'));
  process.env.MEDIA_DIR = root;
  process.env.THUMB_DIR = path.join(root, 'thumbs');
  process.env.DB_PASS = 'test-only';
  fs.writeFileSync(path.join(root, 'source.mp4'), 'video');
});
test.beforeEach(() => { process.env.MEDIA_DIR = root; });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function scanner(db = {}, extra = {}, maintenance = { withMaintenance: operation => operation() }) {
  return load('scanner.js', { './db': db, './lib/maintenance': maintenance, ...extra });
}

test('scanner has no implicit media directory fallback', () => {
  const configured = process.env.MEDIA_DIR;
  delete process.env.MEDIA_DIR;
  try {
    assert.equal(scanner().MEDIA_DIR, undefined);
  } finally {
    process.env.MEDIA_DIR = configured;
  }
});

test('CLI rejects invalid arguments without loading DB or scanner', async () => {
  const cli = load('cli.js', {
    './db': new Proxy({}, { get() { assert.fail('DB loaded before validation'); } }),
    './scanner': new Proxy({}, { get() { assert.fail('scanner loaded before validation'); } }),
  });
  for (const args of [[], ['clear'], ['clear', '--yes'], ['scan', 'typo'], ['scan', 'all', 'extra'], ['clear', '--confirm', 'extra']]) {
    await assert.rejects(cli.main(args), /Usage:/);
  }
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'scan', 'typo'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test('CLI prints the numeric done count and uses completed, including a successful empty scan', async t => {
  const messages = [];
  t.mock.method(console, 'log', message => messages.push(message));
  let progress, closed = 0;
  const cli = load('cli.js', {
    './db': { initSchema: async () => {}, pool: { end: async () => { closed++; } } },
    './scanner': { runScan: async () => progress },
    './lib/maintenance': { withMaintenance: operation => operation() },
  });
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = 0;
    progress = { phase: 'done', done: 0, completed: true, errors: 0 };
    await cli.main(['scan', 'photos']);
    assert.equal(process.exitCode, 0);
    assert.equal(messages.at(-1), 'Scan done: 0 files indexed, 0 errors.');
    progress = { phase: 'cancelled', done: 7, completed: false, errors: 0 };
    await cli.main(['scan', 'photos']);
    assert.equal(process.exitCode, 1);
    assert.equal(messages.at(-1), 'Scan cancelled: 7 files indexed, 0 errors.');
    assert.equal(closed, 2);
  } finally { process.exitCode = previousExitCode; }
});

test('clear uses a transaction and cascading DELETE, preserving FK checks and sequences', async () => {
  const calls = [];
  let reject = false;
  const conn = {
    beginTransaction: async () => calls.push('begin'),
    query: async sql => { calls.push(sql); if (reject && sql === 'DELETE FROM performers') throw new Error('DB failure'); },
    commit: async () => calls.push('commit'), rollback: async () => calls.push('rollback'), release: () => calls.push('release'),
  };
  const db = load('db.js', {
    'mysql2/promise': { createPool: () => ({ getConnection: async () => conn }) },
    './lib/maintenance': { withMaintenance: async operation => { calls.push('lock'); try { return await operation(); } finally { calls.push('unlock'); } } },
  });
  await db.clearAll();
  assert.deepEqual(calls, ['lock', 'begin', 'DELETE FROM media', 'DELETE FROM performers', 'DELETE FROM tags', 'commit', 'release', 'unlock']);
  calls.length = 0;
  reject = true;
  await assert.rejects(db.clearAll(), /DB failure/);
  assert.deepEqual(calls, ['lock', 'begin', 'DELETE FROM media', 'DELETE FROM performers', 'rollback', 'release', 'unlock']);
});

test('real maintenance wrapper excludes a concurrent clear and permits nested batch operations', async () => {
  let held = false, entered, finish;
  const ready = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { finish = resolve; });
  const deletes = [];
  const pool = {
    getConnection: async () => ({
      query: async sql => {
        if (sql.includes('GET_LOCK')) {
          const acquired = held ? 0 : 1;
          held = true;
          return [[{ acquired }]];
        }
        if (sql.includes('RELEASE_LOCK')) { held = false; return [[{}]]; }
        deletes.push(sql);
        return [{}];
      },
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    }),
    query: async sql => sql.startsWith('SELECT') ? [[]] : [{ affectedRows: 1 }],
  };
  const maintenance = load('lib/maintenance.js', { '../db': { pool } });
  const db = load('db.js', { 'mysql2/promise': { createPool: () => pool }, './lib/maintenance': maintenance });
  const work = maintenance.withMaintenance(async () => {
    assert.equal(await db.batchInsertMedia([[1, 'a.jpg', '/a.jpg', 'photo', 'image/jpeg', 1, null, null, null]]), 1);
    entered();
    await barrier;
  });
  await ready;
  await assert.rejects(db.clearAll(), { status: 409 });
  assert.deepEqual(deletes, []);
  finish();
  await work;
  await db.clearAll();
  assert.deepEqual(deletes, ['DELETE FROM media', 'DELETE FROM performers', 'DELETE FROM tags']);
  assert.equal(held, false);
});

test('path collation migration changes only path identity columns and is restart-idempotent', async () => {
  const columns = [
    { table_name: 'performers', column_name: 'name', collation_name: 'utf8mb4_unicode_ci' },
    { table_name: 'performers', column_name: 'dir_path', collation_name: 'utf8mb4_unicode_ci' },
    { table_name: 'media', column_name: 'file_path', collation_name: 'utf8mb4_unicode_ci' },
  ];
  const alterations = [];
  let locked = false;
  const connection = {
    release() {},
    query: async sql => {
      if (sql.includes('information_schema.COLUMNS')) return [columns];
      if (sql.includes(' MODIFY ') && /ALTER TABLE (performers|media)\b/.test(sql)) {
        assert.equal(locked, true);
        alterations.push(sql);
        const [, table, column] = /ALTER TABLE (\w+) MODIFY (\w+)/.exec(sql);
        columns.find(item => item.table_name === table && item.column_name === column).collation_name = 'utf8mb4_nopad_bin';
      }
      return [[]];
    },
  };
  const db = load('db.js', {
    'mysql2/promise': { createPool: () => ({ getConnection: async () => connection }) },
    './lib/maintenance': { withMaintenance: async operation => { locked = true; try { return await operation(); } finally { locked = false; } } },
  });
  await db.initSchema();
  assert.equal(alterations.length, 3);
  assert.equal(alterations.every(sql => sql.includes('COLLATE utf8mb4_nopad_bin NOT NULL')), true);
  await db.initSchema();
  assert.equal(alterations.length, 3);
});

test('batch inserts count real new paths, deduplicate exactly and propagate DB errors', async () => {
  const calls = [];
  let fail = false;
  const db = load('db.js', {
    'mysql2/promise': { createPool: () => ({ query: async (sql, values) => {
      calls.push([sql, values]);
      if (sql.startsWith('SELECT')) return [[{ file_path: '/media/a.jpg' }]];
      if (fail) throw new Error('FK constraint');
      return [{ affectedRows: 1 }];
    } }) },
    './lib/maintenance': { withMaintenance: operation => operation() },
  });
  const record = name => [1, name, `/media/${name}`, 'photo', 'image/jpeg', 1, null, null, null];
  assert.equal(await db.batchInsertMedia([record('a.jpg'), record('A.jpg'), record('A.jpg')]), 1);
  assert.doesNotMatch(calls[1][0], /IGNORE/);
  assert.equal(calls[1][1][2], '/media/A.jpg');
  fail = true;
  await assert.rejects(db.batchInsertMedia([record('B.jpg')]), /FK constraint/);
});

test('scanner excludes quarantine, hidden maintenance paths and symlinks; reports insertion failures', async () => {
  const media = path.join(root, 'scan');
  fs.mkdirSync(path.join(media, 'Alice', '.xflix-work'), { recursive: true });
  fs.mkdirSync(path.join(media, '.xflix-trash', 'Alice'), { recursive: true });
  fs.writeFileSync(path.join(media, 'Alice', 'a.jpg'), 'image');
  fs.writeFileSync(path.join(media, 'Alice', 'A.jpg'), 'image');
  fs.writeFileSync(path.join(media, 'Alice', '.xflix-work', 'hidden.jpg'), 'image');
  fs.writeFileSync(path.join(media, '.xflix-trash', 'Alice', 'trash.jpg'), 'image');
  fs.symlinkSync('/etc/passwd', path.join(media, 'Alice', 'escape.jpg'));
  process.env.MEDIA_DIR = media;
  let records, failing = false;
  const scan = scanner({
    getAllExistingFilePaths: async () => new Map(), upsertPerformer: async () => 1,
    updatePerformerCounts: async () => {},
    pool: { query: async () => [[]] },
    batchInsertMedia: async rows => { if (failing) throw new Error('insert failed'); records = rows; return rows.length; },
  });
  await scan.runScan('photos');
  assert.deepEqual(records.map(row => row[1]).sort(), ['A.jpg', 'a.jpg']);
  assert.equal(scan.getProgress().done, 2);
  assert.equal(scan.getProgress().completed, true);
  failing = true;
  await assert.rejects(scan.runScan('photos'), /insert failed/);
  assert.equal(scan.getProgress().done, 0);
  assert.equal(scan.getProgress().completed, false);
  assert.equal(scan.getProgress().running, false);
  assert.equal(scan.getProgress().lastError, 'insert failed');
  const brokenFS = { ...fs, promises: { ...fs.promises, readdir: async () => { throw new Error('walk denied'); } } };
  await assert.rejects(scanner({}, { fs: brokenFS }).runScan(), /walk denied/);
  process.env.MEDIA_DIR = root;
});

test('video thumbnail dedup precedes output existence, retries cleanly and removes failed partials', async () => {
  const source = path.join(root, 'source.mp4');
  fs.writeFileSync(source, 'video');
  let calls = 0, fail = true;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  let proceed;
  const paused = new Promise(resolve => { proceed = resolve; });
  const scan = scanner({}, { child_process: { execFile: (binary, args, options, callback) => {
    const output = args.at(-1);
    calls++;
    fs.writeFileSync(output, 'partial');
    started();
    paused.then(() => callback(fail ? new Error('encode failed') : null));
  } } });
  const first = scan.generateVideoThumb(source, 12);
  await startedPromise;
  const finalPath = path.join(process.env.THUMB_DIR, 'v_12.jpg');
  assert.equal(fs.existsSync(finalPath), false);
  // Another process publishing a file must not bypass this process's in-flight promise.
  fs.writeFileSync(finalPath, 'other process');
  let secondFinished = false;
  const second = scan.generateVideoThumb(source, 12);
  second.then(() => { secondFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondFinished, false);
  proceed();
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  fs.unlinkSync(finalPath);
  assert.equal(calls, 2);
  assert.equal(fs.readdirSync(process.env.THUMB_DIR).some(name => name.startsWith('.xflix-write-')), false);
  fail = false;
  assert.ok(await scan.generateVideoThumb(source, 12));
  assert.equal(calls, 3);
  assert.ok(await scan.generateVideoThumb(source, 12));
  assert.equal(calls, 3);
  await assert.rejects(scan.generateVideoThumb('/etc/passwd', 13), { code: 'EACCES' });
});

test('photo generation uses real sharp, atomic output, and refuses unsafe destination symlinks', async () => {
  const sharp = require('sharp');
  const source = path.join(root, 'real.png');
  await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toFile(source);
  const scan = scanner();
  const destination = await scan.generatePhotoThumb(source, 21);
  assert.equal((await sharp(destination).metadata()).format, 'jpeg');
  fs.symlinkSync('/etc/passwd', path.join(process.env.THUMB_DIR, 'p_22.jpg'));
  await assert.rejects(scan.generatePhotoThumb(source, 22), { code: 'EACCES' });
  fs.writeFileSync(path.join(root, 'bad.jpg'), 'bad data');
  assert.equal(await scan.generatePhotoThumb(path.join(root, 'bad.jpg'), 23), null);
  assert.equal(fs.existsSync(path.join(process.env.THUMB_DIR, 'p_23.jpg')), false);
});

test('enrichment keyset pagination passes permanently unprobeable rows beyond 2000', async () => {
  const source = path.join(root, 'source.mp4');
  const cursors = [];
  const scan = scanner({ pool: { query: async (sql, params) => {
    assert.match(sql, /id > \? ORDER BY id LIMIT \?/);
    cursors.push(params[0]);
    return [Array.from({ length: Math.min(params[1], 2101 - params[0]) }, (_, i) => ({ id: params[0] + i + 1, file_path: source }))];
  } } }, { child_process: { execFile: (binary, args, options, callback) => callback(new Error('bad file')) } });
  await scan.enrichVideoMeta();
  assert.deepEqual(cursors, [0, 500, 1000, 1500, 2000, 2101]);
  await assert.rejects(scan.enrichVideoMeta(0), /Concurrency/);
});

test('enrichment propagates DB failure only after all sibling workers finish under the lock', async () => {
  let locked = false, siblingFinished = false;
  const source = path.join(root, 'source.mp4');
  const scan = scanner({ pool: { query: async (sql, params) => {
    if (sql.startsWith('SELECT')) return [[{ id: 1, file_path: source }, { id: 2, file_path: source }]];
    if (params.at(-1) === 1) throw new Error('DB update failed');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(locked, true);
    siblingFinished = true;
    return [{}];
  } } }, { child_process: { execFile: (binary, args, options, callback) => callback(null, '{"format":{"duration":"1"},"streams":[]}') } }, {
    withMaintenance: async operation => { locked = true; try { return await operation(); } finally { locked = false; } },
  });
  await assert.rejects(scan.enrichVideoMeta(2), /DB update failed/);
  assert.equal(siblingFinished, true);
  assert.equal(locked, false);
});

test('missing ffprobe is an operational error rather than a successful empty enrichment', async () => {
  const scan = scanner({}, { child_process: { execFile: (binary, args, options, callback) => callback(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })) } });
  await assert.rejects(scan.getVideoMeta(path.join(root, 'source.mp4')), { code: 'EPROBE' });
});
