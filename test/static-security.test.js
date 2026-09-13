'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('frontend contains no executable inline event attributes', () => {
  const sources = ['public/index.html', 'public/admin.html', 'public/js/app.js', 'public/js/admin.js']
    .map(read).join('\n');
  assert.doesNotMatch(sources, /\son(?:click|error|load|submit|change|input|keydown)\s*=/i);
});

test('CSP does not allow inline JavaScript and tokens are not written to localStorage', () => {
  const server = read('server.js');
  const frontend = read('public/js/app.js') + read('public/js/admin.js');
  assert.match(server, /scriptSrc:\s*\["'self'"\]/);
  assert.doesNotMatch(server, /scriptSrc:[^\n]*unsafe-inline/);
  assert.doesNotMatch(frontend, /localStorage\.setItem\(['"]xflix_token/);
});

test('reset URLs and authentication tokens are not logged or accepted from query strings', () => {
  const authRoute = read('routes/auth.js');
  const authMiddleware = read('middleware/auth.js');
  assert.doesNotMatch(authRoute, /console\.(?:info|log)\([^\n]*resetUrl/);
  assert.doesNotMatch(authMiddleware, /req\.query\??\.token/);
});
