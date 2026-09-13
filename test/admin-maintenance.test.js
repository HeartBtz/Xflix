'use strict';

process.env.XFLIX_MEDIA_WRITE = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: tick } = require('node:timers/promises');

// Replace every production-facing dependency before loading routes or helpers.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xflix-admin-test-'));
const mediaRoot = path.join(temporary, 'media');
const thumbRoot = path.join(temporary, 'thumbs');
let state;
let queries;
let queryHook;
let accountCalls;
let accountError;
let commitError;
let lockOwner = null;
let sequence = 0;

async function query(sql, params = [], connection) {
  queries.push(sql);
  if (queryHook) await queryHook(sql, params, connection);
  if (sql.startsWith('SELECT GET_LOCK')) {
    if (lockOwner !== null) return [[{ acquired: 0 }]];
    lockOwner = connection.id;
    return [[{ acquired: 1 }]];
  }
  if (sql.startsWith('SELECT RELEASE_LOCK')) {
    assert.equal(lockOwner, connection.id);
    lockOwner = null;
    return [[{ released: 1 }]];
  }
  const data = connection?.transaction || state;
  if (sql.startsWith('CREATE TABLE IF NOT EXISTS admin_media_journal')) return [{}];
  if (sql.startsWith('SELECT * FROM media WHERE id IN')) return [data.media.filter(row => params[0].includes(row.id))];
  if (sql.startsWith('SELECT * FROM media WHERE id NOT IN')) return [data.media.filter(row => !params[0].includes(row.id) && row.type === params[1])];
  for (const table of ['comments', 'media_reactions', 'user_favorites', 'media_tags']) {
    if (sql.startsWith(`SELECT * FROM ${table} WHERE`)) return [data[table].filter(row => params[0].includes(row.media_id))];
  }
  if (sql.startsWith('SELECT * FROM performers WHERE')) return [data.performers];
  if (sql.startsWith('SELECT t.* FROM tags')) return [data.tags];
  if (sql.startsWith('INSERT INTO admin_media_journal')) {
    data.journals.push({ operation_id: params[0], actor_id: params[1], payload: JSON.parse(params[2]) });
    return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('DELETE FROM media WHERE id IN')) {
    const count = data.media.length;
    data.media = data.media.filter(row => !params[0].includes(row.id));
    return [{ affectedRows: count - data.media.length }];
  }
  if (sql.startsWith('UPDATE performers SET')) return [{ affectedRows: 1 }];
  if (sql.startsWith('SELECT `key`, value FROM settings')) return [Object.entries(data.settings).map(([key, value]) => ({ key, value }))];
  if (sql.startsWith('INSERT INTO settings')) { data.settings[params[0]] = params[1]; return [{ affectedRows: 1 }]; }
  if (sql.startsWith('SELECT id, file_path, type FROM media')) return [data.media];
  if (sql.startsWith('SELECT id FROM media WHERE id =')) return [data.media.filter(row => row.id === params[0])];
  if (sql.startsWith("SELECT id, file_path, duration FROM media WHERE type = 'video'")) return [data.media.filter(row => row.type === 'video' && row.duration > 0 && row.duration < params[0]).slice(0, 501)];
  if (sql.startsWith('SELECT m.id, m.file_path, m.size')) return [data.media];
  throw new Error(`Unexpected mock SQL: ${sql}`);
}

const pool = {
  query: (sql, params) => query(sql, params),
  async getConnection() {
    return {
      id: ++sequence,
      transaction: null,
      query(sql, params) { return query(sql, params, this); },
      async beginTransaction() { this.transaction = structuredClone(state); },
      async commit() {
        if (commitError) throw commitError;
        state = this.transaction;
        this.transaction = null;
      },
      async rollback() { this.transaction = null; },
      release() {},
      destroy() {},
    };
  },
};

const scanner = {
  MEDIA_DIR: mediaRoot, THUMB_DIR: thumbRoot,
  VIDEO_EXTS: new Set(['.mp4']), PHOTO_EXTS: new Set(['.jpg']),
  running: false, cancels: 0,
  getProgress() { return { running: this.running, cancelled: false, errors: 0 }; },
  cancelScan() { this.cancels++; },
  async runScan(mode, onProgress, cancelled) {
    this.running = true;
    try {
      if (mode !== 'photos' && !cancelled()) await this.enrichDurations(3, cancelled);
      if (!cancelled()) await this.generateMissingThumbs(3, cancelled);
    } finally { this.running = false; }
  },
  async enrichDurations() {},
  async generateMissingThumbs() {},
  async generateVideoThumb() { return 'mock-thumbnail'; },
  async generatePhotoThumb() { return 'mock-thumbnail'; },
};

function stub(relative, exports) {
  const filename = require.resolve(relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub('../db', {
  pool,
  async updateUserRole(...args) { accountCalls.push(['role', ...args]); if (accountError) throw accountError; },
  async deleteUser(...args) { accountCalls.push(['delete', ...args]); if (accountError) throw accountError; },
});
stub('../scanner', scanner);
stub('../middleware/auth', {
  requireSameOrigin(req, res, next) { next(); },
  requireAdmin(req, res, next) { req.user = { id: 42, role: 'admin' }; next(); },
});
stub('../services/mail', { async testSmtp() { return true; } });
const adminMedia = require('../lib/admin-media');
const express = require('express');
const app = express();
app.use(express.json());
app.use('/admin', require('../routes/admin'));
let server;
let base;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}/admin`;
      resolve();
    });
  });
});

test.beforeEach(async () => {
  assert.equal(lockOwner, null, 'maintenance lock leaked from a previous test');
  await fs.promises.rm(mediaRoot, { recursive: true, force: true });
  await fs.promises.rm(thumbRoot, { recursive: true, force: true });
  await fs.promises.mkdir(mediaRoot);
  await fs.promises.mkdir(thumbRoot);
  state = { media: [], comments: [], media_reactions: [], user_favorites: [], media_tags: [],
    performers: [{ id: 1, name: 'Test', cover_media_id: 1 }], tags: [], journals: [], settings: {} };
  queries = [];
  queryHook = null;
  accountCalls = [];
  accountError = null;
  commitError = null;
  scanner.running = false;
  scanner.cancels = 0;
  delete process.env.XFLIX_ALLOW_MISSING_CLEANUP;
  delete process.env.XFLIX_STORAGE_SENTINEL;
  delete process.env.XFLIX_STORAGE_SENTINEL_VALUE;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await fs.promises.rm(temporary, { recursive: true, force: true });
});

async function media(id, content = 'complete video bytes') {
  const file = path.join(mediaRoot, `${id}.mp4`);
  await fs.promises.writeFile(file, content);
  state.media.push({ id, performer_id: 1, file_path: file, filename: path.basename(file),
    type: 'video', size: Buffer.byteLength(content), duration: 30, codec: 'h264' });
  return file;
}

async function request(endpoint, body, method = 'POST') {
  const response = await fetch(base + endpoint, { method,
    headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  return { status: response.status, body: events.length ? events.at(-1) : JSON.parse(text), events };
}

async function allowMissing() {
  process.env.XFLIX_ALLOW_MISSING_CLEANUP = 'true';
  process.env.XFLIX_STORAGE_SENTINEL = '.storage-test';
  process.env.XFLIX_STORAGE_SENTINEL_VALUE = 'expected-volume';
  await fs.promises.writeFile(path.join(mediaRoot, '.storage-test'), 'expected-volume\n');
}

test('account endpoints call only atomic helpers with the actor and propagate 400/403/404', async () => {
  assert.equal((await request('/users/7/role', { role: 'member' }, 'PATCH')).status, 200);
  assert.equal((await request('/users/8', undefined, 'DELETE')).status, 200);
  assert.deepEqual(accountCalls, [['role', 7, 'member', 42], ['delete', 8, 42]]);
  assert.equal(queries.length, 0);
  for (const status of [400, 403, 404]) {
    accountError = Object.assign(new Error('Atomic account invariant'), { status });
    assert.equal((await request('/users/7', undefined, 'DELETE')).status, status);
  }
  assert.equal((await request('/users/1e2', undefined, 'DELETE')).status, 400);
});

test('destructive confirmations reject coercion, missing deleteFile and over-limit selections before DB access', async () => {
  for (const dry_run of ['false', 0, null, [], {}]) {
    for (const endpoint of ['/clean-media', '/purge-short-videos']) {
      assert.equal((await request(endpoint, { dry_run })).status, 400);
    }
  }
  for (const deleteFile of [undefined, 'true', 1, null]) {
    assert.equal((await request('/media/1', { deleteFile }, 'DELETE')).status, 400);
    assert.equal((await request('/duplicates/delete-bulk', { ids: [1], deleteFile })).status, 400);
  }
  for (const ids of [[], [1, 1], ['1'], [-1], Array.from({ length: 501 }, (_, i) => i + 1)]) {
    assert.equal((await request('/duplicates/delete-bulk', { ids, deleteFile: true })).status, 400);
  }
  for (const max_duration of ['120', 0, 86401, null]) {
    assert.equal((await request('/purge-short-videos', { max_duration })).status, 400);
  }
  assert.equal(queries.length, 0);
});

test('cleanup fails closed on EACCES and EIO instead of classifying files as absent', async t => {
  const file = await media(1);
  const stat = fs.promises.stat;
  for (const code of ['EACCES', 'EIO']) {
    const mocked = t.mock.method(fs.promises, 'stat', async (target, ...args) => {
      if (target === file) throw Object.assign(new Error(code), { code });
      return stat(target, ...args);
    });
    const result = await request('/clean-media', { dry_run: false });
    assert.equal(result.body.status, 'error');
    assert.equal(state.media.length, 1);
    assert.equal(state.journals.length, 0);
    mocked.mock.restore();
  }
  assert.equal(queries.some(sql => sql.startsWith('DELETE')), false);
});

test('cleanup completes all inventory reads before writes and propagates thumbnail storage failures', async t => {
  const file = await media(1);
  await fs.promises.rm(file);
  await allowMissing();
  const readdir = fs.promises.readdir;
  t.mock.method(fs.promises, 'readdir', async (target, ...args) => {
    if (target === thumbRoot) throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
    return readdir(target, ...args);
  });
  assert.equal((await request('/clean-media', { dry_run: false })).body.status, 'error');
  assert.equal(queries.some(sql => sql.startsWith('DELETE')), false);
  assert.equal(state.media.length, 1);
});

test('missing cleanup is disabled by default, rejects wrong sentinel, then archives on explicit opt-in', async () => {
  await fs.promises.rm(await media(1));
  const preview = await request('/clean-media', {});
  assert.equal(preview.body.status, 'done');
  assert.equal(preview.body.orphaned_db, 1);
  assert.equal(preview.body.deleted_db, 0);
  assert.equal((await request('/clean-media', { dry_run: false })).body.status, 'error');
  await allowMissing();
  process.env.XFLIX_STORAGE_SENTINEL_VALUE = 'wrong';
  assert.equal((await request('/clean-media', { dry_run: false })).body.status, 'error');
  process.env.XFLIX_STORAGE_SENTINEL_VALUE = 'expected-volume';
  const result = await request('/clean-media', { dry_run: false });
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.deleted_db, 1);
  assert.equal(state.journals[0].payload.reason, 'missing');
});

test('missing parent directories are not evidence authorizing DB cleanup', async () => {
  await media(1);
  state.media[0].file_path = path.join(mediaRoot, 'unmounted-subtree', 'absent.mp4');
  await allowMissing();
  assert.equal((await request('/clean-media', { dry_run: false })).body.status, 'error');
  assert.equal(state.media.length, 1);
});

test('media quarantine commits a full SQL snapshot and fsynced journal, preserving thumbnails', async () => {
  const file = await media(1);
  state.comments = [{ id: 10, media_id: 1, user_id: 42, content: 'Restore this comment' }];
  state.media_reactions = [{ id: 2, media_id: 1, user_id: 42, type: 'like' }];
  state.user_favorites = [{ media_id: 1, user_id: 42 }];
  state.media_tags = [{ media_id: 1, tag_id: 3 }];
  state.tags = [{ id: 3, name: 'test-tag' }];
  const thumbnail = path.join(thumbRoot, 'v_1.jpg');
  await fs.promises.writeFile(thumbnail, 'thumbnail');
  const result = await request('/media/1', { deleteFile: true }, 'DELETE');
  assert.equal(result.status, 200);
  assert.equal(result.body.deleted, 1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(thumbnail), true);
  const snapshot = state.journals[0].payload;
  assert.equal(snapshot.media[0].codec, 'h264');
  for (const table of ['comments', 'media_reactions', 'user_favorites', 'media_tags', 'performers', 'tags']) assert.equal(snapshot.related[table].length, 1);
  assert.equal(await fs.promises.readFile(snapshot.moves[0].to, 'utf8'), 'complete video bytes');
  const journal = await fs.promises.readFile(path.join(path.dirname(snapshot.moves[0].to), 'journal.jsonl'), 'utf8');
  assert.match(journal, /"state":"prepared"/);
  assert.match(journal, /"state":"committed"/);
});

test('deleteFile false archives SQL rows without moving the media', async () => {
  const file = await media(1);
  const result = await request('/media/1', { deleteFile: false }, 'DELETE');
  assert.equal(result.status, 200);
  assert.equal(result.body.quarantined, 0);
  assert.equal(fs.existsSync(file), true);
  assert.equal(state.media.length, 0);
});

test('optional dry_run on media endpoints is strictly boolean and never deletes when true', async () => {
  const file = await media(1);
  await media(2);
  for (const endpoint of ['/media/1', '/duplicates/1']) {
    assert.equal((await request(endpoint, { deleteFile: true, dry_run: 'false' }, 'DELETE')).status, 400);
    assert.equal((await request(endpoint, { deleteFile: true, dry_run: true }, 'DELETE')).body.deleted, 0);
  }
  assert.equal((await request('/duplicates/delete-bulk', { ids: [1], deleteFile: true, dry_run: 'false' })).status, 400);
  assert.equal((await request('/duplicates/delete-bulk', { ids: [1], deleteFile: true, dry_run: true })).body.deleted, 0);
  assert.equal(fs.existsSync(file), true);
  assert.equal(state.media.length, 2);
  assert.equal(queries.some(sql => sql.startsWith('DELETE')), false);
});

test('a media file returning after inventory aborts missing cleanup inside the SQL transaction', async () => {
  const file = await media(1);
  await fs.promises.rm(file);
  await allowMissing();
  queryHook = async sql => {
    if (sql.startsWith('SELECT * FROM media WHERE id IN')) await fs.promises.writeFile(file, 'returned');
  };
  const result = await request('/clean-media', { dry_run: false });
  assert.equal(result.body.status, 'error');
  assert.equal(state.media.length, 1);
  assert.equal(result.body.deleted_db, 0);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'returned');
});

test('unavailable MEDIA_DIR fails closed without creating quarantine or querying deletions', async t => {
  await media(1);
  const realpath = fs.promises.realpath;
  t.mock.method(fs.promises, 'realpath', async (target, ...args) => {
    if (target === mediaRoot) throw Object.assign(new Error('Volume unavailable'), { code: 'ENOENT' });
    return realpath(target, ...args);
  });
  const result = await request('/media/1', { deleteFile: true }, 'DELETE');
  assert.equal(result.body.status, 'error');
  assert.equal(state.media.length, 1);
  assert.equal(queries.some(sql => sql.startsWith('DELETE')), false);
});

test('SQL delete failure rolls back every selected row and compensates disk without losing quarantine', async () => {
  const file = await media(1);
  queryHook = async sql => { if (sql.startsWith('DELETE FROM media')) throw new Error('SQL failure'); };
  const result = await request('/media/1', { deleteFile: true }, 'DELETE');
  assert.equal(result.status, 500);
  assert.equal(result.body.deleted, 0);
  assert.equal(result.body.recovery_required, false);
  assert.equal(state.media.length, 1);
  assert.equal(state.journals.length, 0);
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'complete video bytes');
  const directory = path.join(mediaRoot, '.xflix-trash', result.body.operation_id);
  assert.equal(await fs.promises.readFile(path.join(directory, '1.media'), 'utf8'), 'complete video bytes');
  assert.match(await fs.promises.readFile(path.join(directory, 'journal.jsonl'), 'utf8'), /rolled-back/);
});

test('compensation never overwrites a recreated original and reports manual recovery', async () => {
  const file = await media(1);
  queryHook = async sql => {
    if (sql.startsWith('DELETE FROM media')) {
      await fs.promises.writeFile(file, 'new file');
      throw new Error('SQL failed');
    }
  };
  const result = await request('/media/1', { deleteFile: true }, 'DELETE');
  assert.equal(result.body.status, 'error');
  assert.equal(result.body.recovery_required, true);
  assert.equal(result.body.compensation_errors[0].code, 'EEXIST');
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'new file');
});

test('an ambiguous COMMIT is never reported as zero deletions or total success', async () => {
  const file = await media(1);
  commitError = new Error('Connection lost on COMMIT');
  const result = await request('/media/1', { deleteFile: true }, 'DELETE');
  assert.equal(result.body.status, 'error');
  assert.equal(result.body.deleted, null);
  assert.equal(result.body.recovery_required, true);
  assert.equal(fs.existsSync(file), false);
});

test('duplicates refuse deleting the entire group and verify a complete independent survivor', async () => {
  const first = await media(1);
  const second = await media(2);
  let result = await request('/duplicates/delete-bulk', { ids: [1, 2], deleteFile: true });
  assert.equal(result.body.status, 'error');
  assert.equal(state.media.length, 2);
  result = await request('/duplicates/delete-bulk', { ids: [1], deleteFile: true });
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.deleted, 1);
  assert.ok(result.events.some(event => event.status === 'progress' && event.staged && event.skipped));
  assert.ok(result.events.some(event => event.status === 'progress' && event.staged === false && event.skipped === false));
  assert.equal(fs.existsSync(first), false);
  assert.equal(await fs.promises.readFile(second, 'utf8'), 'complete video bytes');
});

test('survivor search skips unrelated ENOENT and still finds a complete copy with a stale SQL size', async () => {
  const selected = await media(1);
  await fs.promises.rm(await media(2));
  await media(3, 'unrelated');
  const survivor = await media(4);
  state.media[3].size = 1;
  const result = await request('/duplicates/1', { deleteFile: true }, 'DELETE');
  assert.equal(result.status, 200);
  assert.equal(result.body.deleted, 1);
  assert.equal(fs.existsSync(selected), false);
  assert.equal(await fs.promises.readFile(survivor, 'utf8'), 'complete video bytes');
  assert.deepEqual(state.media.map(row => row.id), [2, 3, 4]);
});

test('survivor search never swallows EACCES or EIO even when another valid candidate exists', async t => {
  const selected = await media(1);
  const unreadable = await media(2);
  await media(3);
  const stat = fs.promises.stat;
  for (const code of ['EACCES', 'EIO']) {
    const mocked = t.mock.method(fs.promises, 'stat', async (target, ...args) => {
      if (target === unreadable) throw Object.assign(new Error(code), { code });
      return stat(target, ...args);
    });
    const result = await request('/duplicates/1', { deleteFile: true }, 'DELETE');
    assert.equal(result.body.status, 'error');
    assert.equal(result.body.deleted, 0);
    assert.equal(state.media.length, 3);
    assert.equal(fs.existsSync(selected), true);
    mocked.mock.restore();
  }
});

test('ENOENT for the selected media or for a chosen survivor remains fatal', async t => {
  const selected = await media(1);
  const survivor = await media(2);
  await fs.promises.rm(selected);
  assert.equal((await request('/duplicates/1', { deleteFile: true }, 'DELETE')).body.status, 'error');
  await fs.promises.writeFile(selected, 'complete video bytes');
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    await rename(from, to);
    if (from === selected) await fs.promises.rm(survivor);
  });
  const result = await request('/duplicates/1', { deleteFile: true }, 'DELETE');
  assert.equal(result.body.status, 'error');
  assert.equal(result.body.deleted, 0);
  assert.equal(state.media.length, 2);
  assert.equal(await fs.promises.readFile(selected, 'utf8'), 'complete video bytes');
});

test('matching prefixes, stale client groups and inode aliases are not independent duplicates', async () => {
  const prefix = 'x'.repeat(65536);
  const first = await media(1, prefix + 'A');
  const second = await media(2, prefix + 'B');
  assert.equal((await request('/duplicates/1', { deleteFile: true }, 'DELETE')).status, 409);
  await fs.promises.rm(second);
  await fs.promises.link(first, second);
  assert.equal((await request('/duplicates/1', { deleteFile: true }, 'DELETE')).status, 409);
  assert.equal(state.media.length, 2);
});

test('survivor mutation during quarantine restores selected files and prevents SQL deletion', async t => {
  const first = await media(1);
  const second = await media(2);
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    await rename(from, to);
    if (from === first) await fs.promises.writeFile(second, 'changed duplicate');
  });
  const result = await request('/duplicates/1', { deleteFile: true }, 'DELETE');
  assert.equal(result.status, 409);
  assert.equal(state.media.length, 2);
  assert.equal(fs.existsSync(first), true);
  assert.equal(queries.some(sql => sql.startsWith('DELETE')), false);
});

test('rename failures retain DB rows and do not report success', async t => {
  const file = await media(1);
  t.mock.method(fs.promises, 'rename', async () => { throw Object.assign(new Error('Storage I/O failure'), { code: 'EIO' }); });
  const result = await request('/media/1', { deleteFile: true }, 'DELETE');
  assert.equal(result.body.status, 'error');
  assert.equal(state.media.length, 1);
  assert.equal(fs.existsSync(file), true);
});

test('paths outside media storage, symlink escapes and trash targets are rejected', async () => {
  await media(1);
  const outside = path.join(temporary, 'outside.mp4');
  await fs.promises.writeFile(outside, 'not media');
  state.media[0].file_path = outside;
  assert.equal((await request('/media/1', { deleteFile: true }, 'DELETE')).status, 403);
  const escape = path.join(mediaRoot, 'escape');
  await fs.promises.symlink(temporary, escape);
  state.media[0].file_path = path.join(escape, 'outside.mp4');
  assert.equal((await request('/media/1', { deleteFile: true }, 'DELETE')).status, 403);
  state.media[0].file_path = path.join(mediaRoot, '.xflix-trash', 'missing');
  assert.equal((await request('/media/1', { deleteFile: true }, 'DELETE')).body.status, 'error');
  assert.equal(await fs.promises.readFile(outside, 'utf8'), 'not media');
});

test('selecting an internal symlink A to B never renames B or deletes either SQL row', async () => {
  const alias = await media(1);
  const target = await media(2);
  await fs.promises.rm(alias);
  await fs.promises.symlink(target, alias);
  for (const deleteFile of [true, false]) {
    assert.equal((await request('/media/1', { deleteFile }, 'DELETE')).status, 403);
  }
  assert.equal((await request('/duplicates/1', { deleteFile: true }, 'DELETE')).status, 403);
  assert.equal((await request('/purge-short-videos', { dry_run: false })).body.code, 403);
  assert.equal((await fs.promises.lstat(alias)).isSymbolicLink(), true);
  assert.equal(await fs.promises.readlink(alias), target);
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'complete video bytes');
  assert.equal(state.media.length, 2);
  assert.equal(state.journals.length, 0);
  assert.equal(queries.some(sql => sql.startsWith('DELETE')), false);
});

test('destructive paths reject internal parent aliases and dangling links, including missing cleanup', async () => {
  const target = await media(1);
  const aliasParent = path.join(mediaRoot, 'alias-parent');
  await fs.promises.symlink(mediaRoot, aliasParent);
  state.media[0].file_path = path.join(aliasParent, '1.mp4');
  assert.equal((await request('/media/1', { deleteFile: true }, 'DELETE')).status, 403);
  state.media[0].file_path = path.join(aliasParent, 'missing.mp4');
  await allowMissing();
  assert.equal((await request('/clean-media', { dry_run: false })).body.code, 403);
  const dangling = path.join(mediaRoot, 'dangling.mp4');
  await fs.promises.symlink(path.join(mediaRoot, 'absent.mp4'), dangling);
  state.media[0].file_path = dangling;
  assert.equal((await request('/media/1', { deleteFile: true }, 'DELETE')).status, 403);
  assert.equal((await request('/clean-media', { dry_run: false })).body.code, 403);
  assert.equal((await fs.promises.lstat(dangling)).isSymbolicLink(), true);
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'complete video bytes');
  assert.equal(state.media.length, 1);
});

test('a configured media root alias permits both lexical-root and canonical-root file paths', async t => {
  await media(1);
  await media(2);
  const canonical = path.join(temporary, 'canonical-media');
  await fs.promises.rename(mediaRoot, canonical);
  await fs.promises.symlink(canonical, mediaRoot);
  t.after(async () => {
    await fs.promises.rm(mediaRoot);
    await fs.promises.rename(canonical, mediaRoot);
  });
  state.media[1].file_path = path.join(canonical, '2.mp4');
  for (const id of [1, 2]) {
    const result = await request(`/media/${id}`, { deleteFile: true }, 'DELETE');
    assert.equal(result.status, 200);
    assert.equal(result.body.deleted, 1);
  }
  assert.equal(state.media.length, 0);
  assert.equal((await fs.promises.lstat(mediaRoot)).isSymbolicLink(), true);
});

test('purge is dry-run by default, bounded, and revalidates locked duration before action', async () => {
  const file = await media(1);
  assert.equal((await request('/purge-short-videos', {})).body.deleted, 0);
  assert.equal(fs.existsSync(file), true);
  queryHook = async (sql, params, conn) => {
    if (sql.startsWith('SELECT * FROM media WHERE id IN')) conn.transaction.media[0].duration = 999;
  };
  assert.equal((await request('/purge-short-videos', { dry_run: false })).body.status, 'error');
  assert.equal(fs.existsSync(file), true);
  queryHook = null;
  state.media = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, type: 'video', duration: 1 }));
  assert.equal((await request('/purge-short-videos', { dry_run: false })).body.status, 'error');
  assert.equal(queries.some(sql => sql.startsWith('DELETE')), false);
});

test('cleanup quarantines thumbnails on their own volume, skips trash and leaves unindexed media untouched', async t => {
  const unindexed = path.join(mediaRoot, 'unindexed.mp4');
  await fs.promises.writeFile(unindexed, 'not indexed');
  const thumb = path.join(thumbRoot, 'v_77.jpg');
  await fs.promises.writeFile(thumb, 'orphan thumb');
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (from.startsWith(thumbRoot + path.sep) && !to.startsWith(thumbRoot + path.sep)) {
      throw Object.assign(new Error('Cross-device rename'), { code: 'EXDEV' });
    }
    return rename(from, to);
  });
  const result = await request('/clean-media', { dry_run: false });
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.deleted_thumbs, 1);
  assert.equal(result.body.unindexed_files, 1);
  assert.equal(fs.existsSync(thumb), false);
  assert.equal(fs.existsSync(unindexed), true);
  assert.equal(fs.existsSync(path.join(mediaRoot, '.xflix-trash')), false);
  const trash = path.join(thumbRoot, '.xflix-trash');
  const entries = await fs.promises.readdir(trash);
  assert.equal(entries.length, 1);
  assert.equal(await fs.promises.readFile(path.join(trash, entries[0], 'v_77.jpg'), 'utf8'), 'orphan thumb');
  const journal = await fs.promises.readFile(path.join(trash, entries[0], 'journal.jsonl'), 'utf8');
  assert.match(journal, /thumbnail-move-intent/);
  assert.match(journal, /committed/);
  const preview = await request('/clean-media', {});
  assert.equal(preview.body.unindexed_files, 1);
  assert.equal(preview.body.orphaned_thumbs, 0);
});

test('thumbnail quarantine rejects parent aliases and an aliased trash directory', async () => {
  const real = path.join(thumbRoot, 'real');
  const alias = path.join(thumbRoot, 'alias');
  await fs.promises.mkdir(real);
  await fs.promises.writeFile(path.join(real, 'v_88.jpg'), 'keep');
  await fs.promises.symlink(real, alias);
  await assert.rejects(adminMedia.quarantineThumb(path.join(alias, 'v_88.jpg')), { status: 403 });
  await fs.promises.symlink(real, path.join(thumbRoot, '.xflix-trash'));
  await assert.rejects(adminMedia.quarantineThumb(path.join(real, 'v_88.jpg')), { status: 403 });
  assert.equal(await fs.promises.readFile(path.join(real, 'v_88.jpg'), 'utf8'), 'keep');
});

test('cleanup reports partial committed work as error when a later thumbnail move fails', async t => {
  await fs.promises.rm(await media(1));
  await allowMissing();
  await fs.promises.writeFile(path.join(thumbRoot, 'v_99.jpg'), 'orphan thumbnail');
  t.mock.method(fs.promises, 'rename', async () => { throw Object.assign(new Error('Cross-device rename'), { code: 'EXDEV' }); });
  const result = await request('/clean-media', { dry_run: false });
  assert.equal(result.body.status, 'error');
  assert.equal(result.body.partial, true);
  assert.equal(result.body.deleted_db, 1);
  assert.equal(result.body.deleted_thumbs, 0);
  assert.equal(state.media.length, 0);
  assert.equal(state.journals.length, 1);
});

test('orphan thumbnail symlinks cannot quarantine another media thumbnail', async () => {
  await media(1);
  const live = path.join(thumbRoot, 'v_1.jpg');
  const alias = path.join(thumbRoot, 'v_99.jpg');
  await fs.promises.writeFile(live, 'live thumbnail');
  await fs.promises.symlink(live, alias);
  const result = await request('/clean-media', { dry_run: false });
  assert.equal(result.body.status, 'error');
  assert.equal(await fs.promises.readFile(live, 'utf8'), 'live thumbnail');
  assert.equal((await fs.promises.lstat(alias)).isSymbolicLink(), true);
});

test('journal write failure before rename prevents any media or DB deletion', async t => {
  const file = await media(1);
  const open = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (target, ...args) => {
    if (String(target).endsWith('journal.jsonl')) throw Object.assign(new Error('Journal disk full'), { code: 'ENOSPC' });
    return open(target, ...args);
  });
  const result = await request('/media/1', { deleteFile: true }, 'DELETE');
  assert.equal(result.body.status, 'error');
  assert.equal(fs.existsSync(file), true);
  assert.equal(state.media.length, 1);
  assert.equal(queries.some(sql => sql.startsWith('DELETE')), false);
});

test('failure on the last selected duplicate compensates all earlier moves as one operation', async () => {
  const first = await media(1, 'same');
  const second = await media(2, 'different');
  await media(3, 'same');
  const result = await request('/duplicates/delete-bulk', { ids: [1, 2], deleteFile: true });
  assert.equal(result.body.status, 'error');
  assert.equal(result.body.deleted, 0);
  assert.equal(state.media.length, 3);
  assert.equal(state.journals.length, 0);
  assert.equal(await fs.promises.readFile(first, 'utf8'), 'same');
  assert.equal(await fs.promises.readFile(second, 'utf8'), 'different');
  assert.equal(result.events.some(event => event.status === 'progress' && !event.skipped), false);
});

test('SMTP updates validate all types, erase old secret on changed destination and roll back atomically', async () => {
  state.settings = { smtp_host: 'old.example', smtp_pass: 'old-secret', smtp_user: 'user' };
  for (const body of [{ smtp_host: {} }, { smtp_port: true }, { smtp_secure: 1 }, { smtp_from: 'bad\r\nheader' }, { smtp_pass: [] }]) {
    assert.equal((await request('/settings', body, 'PUT')).status, 400);
  }
  assert.equal(queries.length, 0);
  assert.equal((await request('/settings', { smtp_host: 'new.example', smtp_pass: '\u2022'.repeat(8) }, 'PUT')).status, 200);
  assert.equal(state.settings.smtp_pass, '');
  assert.equal(state.settings.smtp_host, 'new.example');
  assert.equal((await request('/settings', { smtp_host: 'third.example', smtp_pass: 'new-secret' }, 'PUT')).status, 200);
  assert.equal(state.settings.smtp_pass, 'new-secret');
  const before = structuredClone(state.settings);
  queryHook = async (sql, params) => { if (sql.startsWith('INSERT INTO settings') && params[0] === 'smtp_port') throw new Error('SQL failure'); };
  assert.equal((await request('/settings', { smtp_host: 'failed.example', smtp_port: '587' }, 'PUT')).status, 500);
  assert.deepEqual(state.settings, before);
});

test('a second scan cannot cancel the first and post-scan children retain the maintenance lock', async t => {
  let releaseScan;
  let releaseChild;
  let started = false;
  let childStarted = false;
  t.mock.method(scanner, 'runScan', async (mode, onProgress, cancelled) => {
    scanner.running = true;
    started = true;
    try {
      await new Promise(resolve => { releaseScan = resolve; });
      await scanner.enrichDurations(3, cancelled);
      if (!cancelled()) await scanner.generateMissingThumbs(3, cancelled);
    } finally { scanner.running = false; }
  });
  t.mock.method(scanner, 'enrichDurations', async () => {
    childStarted = true;
    await new Promise(resolve => { releaseChild = resolve; });
  });
  const first = request('/scan', {});
  while (!started) await tick();
  assert.equal((await request('/scan', {})).status, 409);
  assert.equal(scanner.cancels, 0);
  releaseScan();
  while (!childStarted) await tick();
  assert.notEqual(lockOwner, null);
  assert.equal((await request('/duplicates/scan', {})).status, 409);
  releaseChild();
  assert.equal((await first).body.status, 'done');
  assert.equal(scanner.cancels, 0);
  assert.equal(lockOwner, null);
});

test('admin delegates all scan phases to runScan exactly once with its cancellation predicate', async t => {
  const run = t.mock.method(scanner, 'runScan');
  const enrich = t.mock.method(scanner, 'enrichDurations');
  const thumbs = t.mock.method(scanner, 'generateMissingThumbs');
  const result = await request('/scan', { mode: 'videos' });
  assert.equal(result.body.status, 'done');
  assert.equal(run.mock.callCount(), 1);
  assert.equal(run.mock.calls[0].arguments[0], 'videos');
  assert.equal(typeof run.mock.calls[0].arguments[1], 'function');
  assert.equal(typeof run.mock.calls[0].arguments[2], 'function');
  assert.equal(enrich.mock.callCount(), 1);
  assert.equal(thumbs.mock.callCount(), 1);
  assert.deepEqual(enrich.mock.calls[0].arguments, [3, run.mock.calls[0].arguments[2]]);
  assert.deepEqual(thumbs.mock.calls[0].arguments, [3, run.mock.calls[0].arguments[2]]);
});

for (const phase of ['enrichDurations', 'generateMissingThumbs']) {
  test(`scan cancellation reaches the ${phase} predicate and drains the child before unlock`, async t => {
    let releaseChild;
    let getCancelled;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const calls = [];
    for (const name of ['enrichDurations', 'generateMissingThumbs']) {
      t.mock.method(scanner, name, async (concurrency, cancelled) => {
        calls.push({ name, concurrency, cancelled });
        if (name !== phase) return;
        getCancelled = cancelled;
        const waiting = new Promise(resolve => { releaseChild = resolve; });
        markStarted();
        await waiting;
      });
    }
    const job = request('/scan', {});
    await started;
    try {
      assert.equal(calls.at(-1).concurrency, 3);
      assert.equal(typeof getCancelled, 'function');
      assert.equal(getCancelled(), false);
      assert.equal((await request('/scan/cancel', {})).body.running, true);
      assert.equal(getCancelled(), true);
      assert.notEqual(lockOwner, null);
      assert.equal((await request('/duplicates/scan', {})).status, 409);
    } finally { releaseChild(); }
    const result = await job;
    assert.equal(result.body.status, 'error');
    assert.equal(result.body.cancelled, true);
    assert.equal(lockOwner, null);
    assert.equal(calls.length, phase === 'enrichDurations' ? 1 : 2);
    assert.ok(calls.every(call => call.concurrency === 3 && typeof call.cancelled === 'function'));
  });
}

test('thumbnail cancellation stops scheduling and awaits all three in-flight children', async t => {
  for (let id = 1; id <= 10; id++) await media(id);
  const pending = [];
  t.mock.method(scanner, 'generateVideoThumb', async () => {
    await new Promise(resolve => pending.push(resolve));
    return 'thumbnail';
  });
  const job = request('/batch-thumbs', {});
  while (pending.length !== 3) await tick();
  const cancel = await request('/batch-thumbs/cancel', {});
  assert.equal(cancel.body.running, true);
  assert.notEqual(lockOwner, null);
  pending.forEach(resolve => resolve());
  const result = await job;
  assert.equal(result.body.status, 'error');
  assert.equal(result.body.cancelled, true);
  assert.equal(result.body.done, 3);
  assert.equal(pending.length, 3);
  assert.equal(lockOwner, null);
});

test('duplicate hashing has at most one active file descriptor even for a large equal-size group', async t => {
  for (let id = 1; id <= 20; id++) await media(id);
  const open = fs.promises.open;
  let active = 0;
  let maximum = 0;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('.mp4')) {
      active++;
      maximum = Math.max(maximum, active);
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); active--; };
    }
    return handle;
  });
  const result = await request('/duplicates/scan', {});
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.groups[0].length, 20);
  assert.equal(maximum, 1);
  assert.equal(active, 0);
});

test('helper booleans and ids do not accept JS truthiness', () => {
  assert.throws(() => adminMedia.booleanInput({ dry_run: 'false' }, 'dry_run', true));
  assert.equal(adminMedia.booleanInput({}, 'dry_run', true), true);
  assert.throws(() => adminMedia.idsInput([Number.MAX_SAFE_INTEGER + 1]));
});
