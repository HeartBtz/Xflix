'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('isolated MariaDB integration', { skip: process.env.XFLIX_INTEGRATION !== '1', timeout: 120000 }, async t => {
  // Never point this destructive fixture at an existing application database.
  assert.match(process.env.DB_NAME || '', /^xflix_test_[a-z0-9_]+$/);
  assert.ok(['127.0.0.1', 'localhost', 'mariadb'].includes(process.env.DB_HOST));
  assert.equal(process.env.DB_USER, 'xflix_test');
  assert.equal(process.env.DB_PASS, 'xflix-disposable-test-only');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xflix-integration-'));
  process.env.MEDIA_DIR = path.join(root, 'media');
  process.env.THUMB_DIR = path.join(root, 'thumbs');
  process.env.JWT_SECRET = 'integration-only-secret-at-least-thirty-two-characters';
  process.env.REQUIRE_AUTH = 'true';
  process.env.XFLIX_MEDIA_WRITE = 'true';
  delete process.env.BASE_URL;
  await fs.mkdir(process.env.MEDIA_DIR);
  await fs.mkdir(process.env.THUMB_DIR);
  const db = require('../db');
  const { signToken } = require('../middleware/auth');
  const { withMaintenance } = require('../lib/maintenance');
  const { removeMedia } = require('../lib/admin-media');
  const bcrypt = require('bcryptjs');
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.pool.end();
    await fs.rm(root, { recursive: true, force: true });
  });
  for (let attempt = 0; ; attempt++) {
    try { await db.pool.query('SELECT 1'); break; }
    catch (error) { if (attempt >= 59) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  await db.initSchema();
  const [[{ count }]] = await db.pool.query('SELECT COUNT(*) AS count FROM users');
  assert.equal(count, 0, 'Integration database must not contain existing users');
  const { app } = require('../server');
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, route, body, cookie) => {
    const res = await fetch(base + route, { method, headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0], headers: res.headers };
  };
  const cookieFor = user => `xflix_session=${signToken(user)}`;
  let admin;
  let adminCookie;
  const password = 'Integration-password-123';
  await t.test('upgrades an old schema and reruns without losing users or changing media identities', async () => {
    await db.pool.query('ALTER TABLE users DROP COLUMN session_version');
    await db.pool.query('ALTER TABLE media MODIFY file_path VARCHAR(1000) COLLATE utf8mb4_unicode_ci NOT NULL');
    await db.initSchema();
    await db.initSchema();
    const [columns] = await db.pool.query('SHOW FULL COLUMNS FROM media WHERE Field = ?', ['file_path']);
    assert.equal(columns[0].Collation, 'utf8mb4_nopad_bin');
    const [version] = await db.pool.query('SHOW COLUMNS FROM users WHERE Field = ?', ['session_version']);
    assert.equal(version[0].Default, '0');
  });

  await t.test('concurrent first registrations produce one administrator and close registration', async () => {
    const responses = await Promise.all(['Alpha', 'Beta'].map(username => request('POST', '/auth/register', {
      username, email: `${username.toLowerCase()}@example.invalid`, password,
    })));
    assert.deepEqual(responses.map(res => res.status).sort(), [201, 403]);
    const registered = responses.find(res => res.status === 201);
    admin = await db.getUserById(registered.body.user.id);
    adminCookie = registered.cookie;
    assert.equal(admin.role, 'admin');
    assert.equal((await request('GET', '/auth/config')).body.allow_registration, false);
  });

  await t.test('new passwords reject bcrypt truncation in bytes, including multibyte input', async () => {
    for (const long of ['a'.repeat(73), '\u00e9'.repeat(37)]) {
      assert.equal((await request('POST', '/auth/register', {
        username: 'TooLong', email: 'long@example.invalid', password: long,
      })).status, 400);
    }
  });

  await t.test('login preserves bio, wrong current password does not expire the session, me never renews Bearer', async () => {
    await db.updateUserProfile(admin.id, { bio: 'Existing profile must be preserved' });
    const login = await request('POST', '/auth/login', { email: admin.email, password });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.bio, 'Existing profile must be preserved');
    adminCookie = login.cookie;
    const wrong = await request('POST', '/auth/change-password', { currentPassword: 'wrong-password', newPassword: password }, adminCookie);
    assert.equal(wrong.status, 400);
    assert.equal((await request('GET', '/auth/me', undefined, adminCookie)).status, 200);
    const res = await fetch(base + '/auth/me', { headers: { Authorization: `Bearer ${signToken(admin)}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('set-cookie'), null);
    await res.arrayBuffer();
  });

  await t.test('logout invalidates every previously issued session and fresh login works', async () => {
    const second = await request('POST', '/auth/login', { email: admin.email, password });
    assert.equal((await request('POST', '/auth/logout', {}, adminCookie)).status, 200);
    assert.equal((await request('GET', '/auth/me', undefined, second.cookie)).status, 401);
    const next = await request('POST', '/auth/login', { email: admin.email, password });
    assert.equal(next.status, 200);
    adminCookie = next.cookie;
    admin = await db.getUserById(admin.id);
  });

  await t.test('password changes and one-time concurrent resets revoke sessions atomically', async () => {
    const id = await db.createUser('ResetUser', 'reset@example.invalid', await bcrypt.hash(password, 4));
    let subject = await db.getUserById(id);
    const previous = cookieFor(subject);
    const changed = await request('POST', '/auth/change-password', { currentPassword: password, newPassword: password + '-new' }, previous);
    assert.equal(changed.status, 200);
    assert.equal((await request('GET', '/api/stats', undefined, previous)).status, 401);
    subject = await db.getUserById(id);
    const beforeReset = cookieFor(subject);
    const token = 'a'.repeat(64);
    await db.setResetToken(id, token, new Date(Date.now() + 60000));
    assert.notEqual((await db.getUserById(id)).reset_token, token);
    const resets = await Promise.all(['-one', '-two'].map(suffix => request('POST', '/auth/reset-password', { token, newPassword: password + suffix })));
    assert.deepEqual(resets.map(res => res.status).sort(), [200, 400]);
    assert.equal((await request('GET', '/api/stats', undefined, beforeReset)).status, 401);
    assert.equal((await db.getUserById(id)).reset_token, null);
    assert.equal(await db.changeUserPassword(id, subject.password_hash, 'stale-write', subject.session_version), false);
    await db.deleteUser(id, admin.id);
  });

  await t.test('deleted account tokens cannot access private content', async () => {
    const id = await db.createUser('DeletedUser', 'deleted@example.invalid', await bcrypt.hash(password, 4));
    const cookie = cookieFor(await db.getUserById(id));
    assert.equal((await request('GET', '/api/stats', undefined, cookie)).status, 200);
    await db.deleteUser(id, admin.id);
    assert.equal((await request('GET', '/api/stats', undefined, cookie)).status, 401);
  });

  await t.test('cross-demotions serialize and recheck the actor, preserving an administrator', async () => {
    const other = await db.createUser('OtherAdmin', 'other@example.invalid', await bcrypt.hash(password, 4), 'admin');
    const results = await Promise.allSettled([
      db.updateUserRole(other, 'member', admin.id), db.updateUserRole(admin.id, 'member', other),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.status, 403);
    const [admins] = await db.pool.query("SELECT * FROM users WHERE role='admin'");
    assert.equal(admins.length, 1);
    admin = admins[0];
    adminCookie = cookieFor(admin);
  });

  const folder = path.join(process.env.MEDIA_DIR, 'Fixture');
  await fs.mkdir(folder);
  const performer = await db.upsertPerformer('Fixture', folder);
  const addMedia = async (name, data = '0123456789') => {
    const file = path.join(folder, name);
    await fs.writeFile(file, data);
    await db.batchInsertMedia([[performer, name, file, 'video', 'video/mp4', Buffer.byteLength(data), null, null, 10]]);
    const [[row]] = await db.pool.query('SELECT * FROM media WHERE file_path = ?', [file]);
    return row;
  };
  let media;
  await t.test('Linux path identity preserves case-distinct names in MariaDB', async () => {
    media = await addMedia('A.mp4');
    const lower = await addMedia('a.mp4');
    assert.notEqual(media.id, lower.id);
  });

  await t.test('social state updates are idempotent with real concurrent transactions', async () => {
    const responses = await Promise.all([1, 2].map(() => request('POST', `/social/favorites/${media.id}`, { favorited: true }, adminCookie)));
    assert.deepEqual(responses.map(res => res.status), [200, 200]);
    const [[row]] = await db.pool.query('SELECT COUNT(*) AS total FROM user_favorites WHERE media_id = ?', [media.id]);
    assert.equal(row.total, 1);
    const reactions = await Promise.all([1, 2].map(() => request('POST', `/social/reactions/${media.id}`, { type: 'like', active: true }, adminCookie)));
    assert.deepEqual(reactions.map(res => res.status), [200, 200]);
    assert.equal((await request('POST', `/social/comments/${media.id}`, { content: 'Preserve this comment in recovery' }, adminCookie)).status, 201);
  });

  await t.test('maintenance lock excludes a separate CLI process', async () => {
    await withMaintenance(async () => {
      const result = spawnSync(process.execPath, ['-e',
        'const db=require("./db");db.clearAll().then(()=>process.exitCode=1,e=>{process.exitCode=e.status===409?0:2;}).finally(()=>db.pool.end());'],
      { cwd: path.resolve(__dirname, '..'), env: process.env, timeout: 10000, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      await withMaintenance(async () => assert.ok(true));
    });
  });

  await t.test('media quarantine preserves a duplicate, SQL recovery data and the original bytes', async () => {
    process.env.XFLIX_MEDIA_WRITE = 'false';
    await assert.rejects(removeMedia({ ids: [media.id], deleteFile: true, actorId: admin.id }), { status: 403 });
    process.env.XFLIX_MEDIA_WRITE = 'true';
    const result = await removeMedia({ ids: [media.id], deleteFile: true, duplicate: true, actorId: admin.id });
    assert.equal(result.deleted, 1);
    const [[journal]] = await db.pool.query('SELECT payload FROM admin_media_journal WHERE operation_id = ?', [result.operation_id]);
    const snapshot = JSON.parse(journal.payload);
    assert.equal(snapshot.related.comments.length, 1);
    assert.equal(snapshot.related.user_favorites.length, 1);
    assert.equal(await fs.readFile(snapshot.moves[0].to, 'utf8'), '0123456789');
    await assert.rejects(fs.stat(media.file_path), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(folder, 'a.mp4'), 'utf8'), '0123456789');
    const [[survivor]] = await db.pool.query('SELECT * FROM media WHERE file_path = ?', [path.join(folder, 'a.mp4')]);
    await assert.rejects(removeMedia({ ids: [survivor.id], deleteFile: true, duplicate: true, actorId: admin.id }), { status: 409 });
  });

  await t.test('clear cascades social data without resetting IDs', async () => {
    const before = await addMedia('before-clear.mp4');
    await request('POST', `/social/comments/${before.id}`, { content: 'Old comment' }, adminCookie);
    await db.clearAll();
    for (const table of ['media', 'comments', 'media_reactions', 'user_favorites', 'media_tags']) {
      const [[row]] = await db.pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
      assert.equal(row.total, 0);
    }
    const nextPerformer = await db.upsertPerformer('Next', folder);
    await db.batchInsertMedia([[nextPerformer, 'new.mp4', path.join(folder, 'new.mp4'), 'video', 'video/mp4', 10, null, null, 10]]);
    const [[next]] = await db.pool.query('SELECT id FROM media');
    assert.ok(next.id > before.id);
  });

  await db.clearAll();
  await db.pool.query('DELETE FROM users');
  await db.pool.query('DELETE FROM settings');
});
