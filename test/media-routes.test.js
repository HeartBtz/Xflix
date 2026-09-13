'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { Readable } = require('node:stream');
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

const pass = (req, res, next) => { req.user = { id: 7, role: 'member' }; next(); };
const auth = { requireContentAuth: pass, requireAdmin: pass, requireAuth: pass, optionalAuth: pass, requireSameOrigin: pass, REQUIRE_CONTENT_AUTH: true };
let root, thumbs;
test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xflix-media-http-'));
  thumbs = path.join(root, 'thumbs');
  fs.mkdirSync(thumbs);
  fs.writeFileSync(path.join(root, 'video.mp4'), '0123456789');
  fs.writeFileSync(path.join(root, 'photo.jpg'), 'photo-original');
  fs.symlinkSync('/etc/passwd', path.join(root, 'escape.jpg'));
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

async function serve(t, router) {
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

function mediaRouter(extra = {}) {
  const rows = {
    1: { id: 1, type: 'video', file_path: path.join(root, 'video.mp4'), mime_type: 'video/mp4' },
    2: { id: 2, type: 'photo', file_path: path.join(root, 'photo.jpg'), mime_type: 'image/jpeg' },
    3: { id: 3, type: 'photo', file_path: path.join(root, 'escape.jpg') },
    4: { id: 4, type: 'photo', file_path: '/etc/passwd', thumb_path: '/etc/passwd' },
    5: { id: 5, type: 'photo', file_path: path.join(root, 'missing.jpg') },
    6: { id: 6, type: 'photo', file_path: root },
  };
  return load('routes/stream.js', {
    '../db': { pool: { query: async (sql, [id]) => [rows[id] ? [rows[id]] : []] }, updateThumb: async () => {} },
    '../scanner': { MEDIA_DIR: root, THUMB_DIR: thumbs, generateVideoThumb: async () => null, generatePhotoThumb: async () => null },
    '../middleware/auth': auth,
    ...extra,
  });
}

test('video ranges, If-Range, HEAD and 304 use consistent private validators', async t => {
  const base = await serve(t, mediaRouter());
  const get = headers => fetch(`${base}/stream/1`, { headers });
  const full = await get();
  assert.equal(await full.text(), '0123456789');
  const etag = full.headers.get('etag');
  const lastModified = full.headers.get('last-modified');
  const range = await get({ Range: 'bytes=2-4', 'If-Range': etag });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(await range.text(), '234');
  const suffix = await get({ Range: 'bytes=-3', 'If-Range': lastModified });
  assert.equal(await suffix.text(), '789');
  for (const validator of ['"stale"', '"9999"', '9999', `W/${etag}`, 'Thu, 01 Jan 1970 00:00:00 GMT', 'garbage']) {
    const response = await get({ Range: 'bytes=2-4', 'If-Range': validator });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '0123456789');
  }
  const unsatisfiable = await get({ Range: 'bytes=99-' });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */10');
  const cached = await get({ 'If-None-Match': `W/${etag}` });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get('etag'), etag);
  assert.match(cached.headers.get('cache-control'), /^private/);
  const head = await fetch(`${base}/stream/1`, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
});

test('photo fallback, downloads and all media reads are confined and privately cached', async t => {
  const base = await serve(t, mediaRouter());
  const fallback = await fetch(`${base}/thumb/2`);
  assert.equal(await fallback.text(), 'photo-original');
  assert.match(fallback.headers.get('cache-control'), /^private/);
  const cached = await fetch(`${base}/thumb/2`, { headers: { 'If-None-Match': fallback.headers.get('etag') } });
  assert.equal(cached.status, 304);
  assert.match(cached.headers.get('cache-control'), /^private/);
  const download = await fetch(`${base}/download/2`);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  await download.arrayBuffer();
  for (const route of ['stream', 'photo', 'thumb', 'download']) {
    for (const id of [3, 4]) assert.equal((await fetch(`${base}/${route}/${id}`)).status, 403, `${route}/${id}`);
    assert.equal((await fetch(`${base}/${route}/5`)).status, 404);
  }
  assert.equal((await fetch(`${base}/photo/6`)).status, 404);
});

test('every serving route handles read errors before headers without a truncated success', async t => {
  const broken = { ...fs, promises: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return {
      stat: () => handle.stat(), close: () => handle.close(),
      createReadStream: () => {
        const stream = new Readable({ read() { this.destroy(new Error('disk read failed')); } });
        stream.once('close', () => handle.close());
        return stream;
      },
    };
  } } };
  const base = await serve(t, mediaRouter({ fs: broken }));
  for (const route of ['stream/1', 'photo/2', 'thumb/2', 'download/2']) {
    const response = await fetch(`${base}/${route}`);
    assert.equal(response.status, 500, route);
    assert.equal(await response.text(), 'File unavailable');
  }
});

test('client disconnection destroys its file stream', async t => {
  let closed;
  const closePromise = new Promise(resolve => { closed = resolve; });
  const delayed = { ...fs, promises: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return {
      stat: async () => ({ ...(await handle.stat()), size: 1000000, isFile: () => true }),
      close: () => handle.close(),
      createReadStream: () => {
        let sent = false;
        const stream = new Readable({ read() { if (!sent) { sent = true; this.push('first'); } } });
        stream.once('close', async () => { await handle.close(); closed(); });
        return stream;
      },
    };
  } } };
  const base = await serve(t, mediaRouter({ fs: delayed }));
  await new Promise((resolve, reject) => {
    const request = http.get(`${base}/stream/1`, response => response.once('data', () => { response.destroy(); resolve(); }));
    request.once('error', reject);
  });
  await Promise.race([closePromise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('stream not destroyed')), 1000); timer.unref(); })]);
});

test('a read failure after headers aborts the response instead of completing a short body', async t => {
  const broken = { ...fs, promises: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return {
      stat: () => handle.stat(), close: () => handle.close(),
      createReadStream: () => {
        let started = false;
        const stream = new Readable({ read() {
          if (started) return;
          started = true;
          this.push('012');
          setTimeout(() => this.destroy(new Error('disk failed mid-read')), 30);
        } });
        stream.once('close', () => handle.close());
        return stream;
      },
    };
  } } };
  const base = await serve(t, mediaRouter({ fs: broken }));
  const response = await fetch(`${base}/stream/1`);
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
});

test('thumbnail uploads reject unsafe destinations and publish valid images atomically', async t => {
  const sharp = require('sharp');
  const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'blue' } }).png().toBuffer();
  const updates = [];
  const router = load('routes/api.js', {
    '../db': { pool: { query: async () => [[{ id: 31 }]] }, updateThumb: async (...args) => updates.push(args) },
    '../scanner': { THUMB_DIR: thumbs }, '../middleware/auth': auth,
    '../lib/maintenance': { withMaintenance: operation => operation() },
  });
  const base = await serve(t, router);
  const post = data => fetch(`${base}/thumb/31/upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
  for (const invalid of [{}, 'not base64!', '', 'A===']) assert.equal((await post(invalid)).status, 400);
  const target = path.join(thumbs, 'c_31.jpg');
  fs.symlinkSync('/etc/passwd', target);
  assert.equal((await post(image.toString('base64'))).status, 500);
  assert.equal(updates.length, 0);
  fs.unlinkSync(target);
  const uploaded = await post(`data:image/png;base64,${image.toString('base64')}`);
  assert.equal(uploaded.status, 200);
  assert.equal((await sharp(target).metadata()).format, 'jpeg');
  const before = fs.readFileSync(target);
  assert.equal((await post(Buffer.from('broken image').toString('base64'))).status, 500);
  assert.deepEqual(fs.readFileSync(target), before);
  assert.equal(fs.readdirSync(thumbs).some(name => name.startsWith('.xflix-write-')), false);
  assert.equal(updates.length, 1);
});

test('social toggles serialize absent rows, preserve legacy behavior and support explicit idempotent states', async t => {
  let reaction = null, favorite = false, lock = Promise.resolve(), failInsert = false;
  const events = [];
  const pool = { getConnection: async () => {
    let unlock, snapshot;
    return {
      beginTransaction: async () => events.push('begin'),
      query: async (sql, values) => {
        if (sql.endsWith('FOR UPDATE')) {
          const previous = lock;
          lock = new Promise(resolve => { unlock = resolve; });
          await previous;
          snapshot = { reaction, favorite };
          return [values[0] === 999 ? [] : [{ id: values[0] }]];
        }
        assert.ok(snapshot, 'parent row must be locked before reading or mutating social state');
        if (sql.startsWith('SELECT id, type')) return [reaction ? [{ id: 1, type: reaction }] : []];
        if (sql.startsWith('SELECT type')) return [reaction ? [{ type: reaction }] : []];
        if (sql.startsWith('SELECT SUM')) return [[{ likes: reaction === 'like' ? 1 : 0, dislikes: reaction === 'dislike' ? 1 : 0 }]];
        if (sql.startsWith('SELECT 1')) return [favorite ? [{ 1: 1 }] : []];
        if (sql.startsWith('INSERT') && failInsert) throw new Error('insert failed');
        if (sql.startsWith('INSERT INTO media_reactions')) reaction = values[2];
        else if (sql.startsWith('UPDATE media_reactions')) reaction = values[0];
        else if (sql.startsWith('DELETE FROM media_reactions')) reaction = null;
        else if (sql.startsWith('INSERT INTO user_favorites')) favorite = true;
        else if (sql.startsWith('DELETE FROM user_favorites')) favorite = false;
        else assert.fail(`Unexpected query: ${sql}`);
        return [{}];
      },
      commit: async () => events.push('commit'),
      rollback: async () => { events.push('rollback'); if (snapshot) ({ reaction, favorite } = snapshot); },
      release: () => { events.push('release'); if (unlock) unlock(); },
    };
  } };
  const base = await serve(t, load('routes/social.js', { '../db': { pool }, '../middleware/auth': auth }));
  const post = async (route, body = {}) => {
    const response = await fetch(`${base}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const toggles = await Promise.all([post('favorites/1'), post('favorites/1')]);
  assert.deepEqual(toggles.map(result => result.body.favorited).sort(), [false, true]);
  assert.equal(favorite, false);
  await Promise.all([post('favorites/1', { favorited: true }), post('favorites/1', { favorited: true })]);
  assert.equal(favorite, true);
  assert.equal((await post('favorites/1', { favorited: false })).body.favorited, false);
  const reactions = await Promise.all([post('reactions/1', { type: 'like' }), post('reactions/1', { type: 'like' })]);
  assert.equal(reactions.every(result => result.status === 200), true);
  assert.equal(reaction, null);
  await Promise.all([post('reactions/1', { type: 'like', active: true }), post('reactions/1', { type: 'like', active: true })]);
  assert.equal(reaction, 'like');
  assert.deepEqual((await post('reactions/1', { type: 'dislike' })).body, { likes: 0, dislikes: 1, userReaction: 'dislike' });
  await post('reactions/1', { type: 'dislike', active: false });
  assert.equal(reaction, null);
  assert.equal((await post('favorites/999')).status, 404);
  assert.equal((await post('reactions/nope', { type: 'like' })).status, 400);
  assert.equal((await post('favorites/1', { favorited: 'false' })).status, 400);
  failInsert = true;
  assert.equal((await post('reactions/1', { type: 'like' })).status, 500);
  assert.equal(reaction, null);
  assert.ok(events.includes('rollback'));
  assert.equal(events.filter(event => event === 'begin').length, events.filter(event => event === 'release').length);
});
