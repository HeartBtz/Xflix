'use strict';

process.env.JWT_SECRET = 'test-only-secret-that-is-longer-than-thirty-two-characters';
process.env.JWT_EXPIRES = '1h';
process.env.DB_PASS = 'test-only-db-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
let currentUser;
let dbError = false;
require.cache[require.resolve('../db')] = { exports: {
  getUserById: async id => {
    if (dbError) throw new Error('DB unavailable');
    return currentUser?.id === id ? currentUser : null;
  },
} };
test.beforeEach(() => { currentUser = { id: 9, username: 'bob', role: 'admin', session_version: 0 }; dbError = false; });
const {
  signToken, verifyToken, requireAuth, requireSameOrigin, setSessionCookie,
} = require('../middleware/auth');

function request(overrides = {}) {
  const headers = Object.fromEntries(Object.entries(overrides.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method: 'GET', protocol: 'https', secure: true, query: {},
    headers,
    get(name) { return headers[name.toLowerCase()]; },
    ...overrides,
    headers,
  };
}

function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    append(name, value) { this.headers[name] = [...(this.headers[name] || []), value]; },
  };
}

test('JWTs use a validated subject and cannot be substituted with a query token', async () => {
  const token = signToken({ id: 7, username: 'alice', role: 'member' });
  assert.equal(verifyToken(token).id, 7);

  const req = request({ query: { token } });
  const res = response();
  let called = false;
  await requireAuth(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('rejects legacy Bearer tokens instead of weakening issuer and audience checks', async () => {
  const token = jwt.sign(
    { id: 11, username: 'legacy', role: 'member' },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' },
  );
  const req = request({ headers: { authorization: `Bearer ${token}` } });
  const res = response();
  let called = false;
  await requireAuth(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('accepts the HttpOnly session cookie and emits hardened cookie attributes', async () => {
  const token = signToken({ id: 9, username: 'bob', role: 'admin' });
  const req = request({ headers: { cookie: `xflix_session=${encodeURIComponent(token)}` } });
  const res = response();
  let called = false;
  await requireAuth(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.user.id, 9);

  setSessionCookie(req, res, token);
  const cookie = res.headers['Set-Cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /test-only-secret/);
});

test('rejects deleted users and revoked sessions even with a correctly signed JWT', async () => {
  const token = signToken(currentUser);
  for (const user of [null, { ...currentUser, session_version: 1 }]) {
    currentUser = user;
    const res = response();
    await requireAuth(request({ headers: { cookie: `xflix_session=${token}` } }), res, () => assert.fail('Session accepted'));
    assert.equal(res.statusCode, 401);
  }
});

test('reads current roles and returns 503 without clearing a valid cookie on DB outage', async () => {
  const token = signToken(currentUser);
  currentUser.role = 'member';
  const req = request({ headers: { cookie: `xflix_session=${token}` } });
  await requireAuth(req, response(), () => {});
  assert.equal(req.user.role, 'member');
  dbError = true;
  const res = response();
  await requireAuth(req, res, () => assert.fail('DB failure allowed access'));
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['Set-Cookie'], undefined);
});

test('does not fall back for tokens with a wrong issuer or missing session version', async () => {
  for (const claims of [{ sub: '9', sv: 0, iss: 'other', aud: 'xflix-web', id: 9 }, { sub: '9', iss: 'xflix', aud: 'xflix-web' }]) {
    const token = jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '1h' });
    const res = response();
    await requireAuth(request({ headers: { authorization: `Bearer ${token}` } }), res, () => assert.fail('Invalid token accepted'));
    assert.equal(res.statusCode, 401);
  }
});

test('rejects cross-site mutation requests', () => {
  const req = request({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site', host: 'xflix.test' } });
  const res = response();
  let called = false;
  requireSameOrigin(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('explicit public origin supports HTTPS ingress with an HTTP backend without trusting forwarded headers', t => {
  const previous = process.env.BASE_URL;
  t.after(() => { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; });
  const req = request({ method: 'POST', protocol: 'http', secure: false, headers: {
    host: 'media.example.test', origin: 'https://media.example.test',
    'sec-fetch-site': 'same-origin', 'x-forwarded-proto': 'https',
  } });
  delete process.env.BASE_URL;
  const rejected = response();
  requireSameOrigin(req, rejected, () => assert.fail('Missing public-origin configuration accepted'));
  assert.equal(rejected.statusCode, 403);
  process.env.BASE_URL = 'https://media.example.test';
  let accepted = false;
  requireSameOrigin(req, response(), () => { accepted = true; });
  assert.equal(accepted, true);
});

test('canonical HTTPS origin still rejects foreign, opaque, insecure and cross-site requests', t => {
  const previous = process.env.BASE_URL;
  t.after(() => { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; });
  process.env.BASE_URL = 'https://media.example.test';
  for (const origin of ['https://evil.example.test', 'https://media.example.test.evil.test', 'http://media.example.test', 'null']) {
    const res = response();
    requireSameOrigin(request({ method: 'POST', protocol: 'http', headers: {
      host: 'media.example.test', origin, 'sec-fetch-site': 'same-origin',
    } }), res, () => assert.fail('Foreign origin accepted'));
    assert.equal(res.statusCode, 403);
  }
  const res = response();
  requireSameOrigin(request({ method: 'POST', headers: {
    origin: process.env.BASE_URL, 'sec-fetch-site': 'cross-site',
  } }), res, () => assert.fail('Cross-site metadata accepted'));
  assert.equal(res.statusCode, 403);
});

test('HTTPS-only deployment emits Secure cookies even when the backend connection is HTTP', t => {
  const previous = process.env.COOKIE_SECURE;
  t.after(() => { if (previous === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = previous; });
  process.env.COOKIE_SECURE = 'true';
  const res = response();
  setSessionCookie(request({ protocol: 'http', secure: false }), res, signToken(currentUser));
  assert.match(res.headers['Set-Cookie'][0], /; Secure(?:;|$)/);
  assert.match(res.headers['Set-Cookie'][0], /; HttpOnly(?:;|$)/);
  assert.match(res.headers['Set-Cookie'][0], /; SameSite=Strict(?:;|$)/);
});
