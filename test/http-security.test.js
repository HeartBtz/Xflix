'use strict';

process.env.JWT_SECRET = 'http-test-secret-that-is-longer-than-thirty-two-characters';
process.env.DB_PASS = 'test-only-db-password';
process.env.REQUIRE_AUTH = 'true';
process.env.MEDIA_DIR = '/tmp';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');
const { version } = require('../package.json');

let server;
let baseUrl;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('serves the SPA with restrictive browser security headers', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

test('reports the exact deployed application version without authentication', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', version });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('blocks unauthenticated API and media access before touching the database', async () => {
  const [api, thumbnail, stream] = await Promise.all([
    fetch(`${baseUrl}/api/stats`),
    fetch(`${baseUrl}/thumb/1`),
    fetch(`${baseUrl}/stream/1`),
  ]);
  assert.equal(api.status, 401);
  assert.equal(thumbnail.status, 401);
  assert.equal(stream.status, 401);
});

test('rejects a cross-site logout request', async () => {
  const response = await fetch(`${baseUrl}/auth/logout`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(response.status, 403);
});
