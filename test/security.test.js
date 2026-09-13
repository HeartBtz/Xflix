'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { envFlag, hashResetToken, validateBaseUrl, parseByteRange, boundedInteger } = require('../lib/security');

test('hashes reset tokens deterministically without retaining the raw token', () => {
  const raw = 'very-secret-reset-token';
  const hash = hashResetToken(raw);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, hashResetToken(raw));
  assert.equal(hash.includes(raw), false);
});

test('validates password reset base URLs', () => {
  assert.equal(validateBaseUrl('https://xflix.example.test/'), 'https://xflix.example.test');
  assert.throws(() => validateBaseUrl('javascript:alert(1)'));
  assert.throws(() => validateBaseUrl('https://user:pass@example.test'));
});

test('parses normal, open-ended, and suffix byte ranges', () => {
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.equal(parseByteRange('bytes=100-101', 100), false);
  assert.equal(parseByteRange('bytes=20-10', 100), false);
  assert.equal(parseByteRange('not-a-range', 100), false);
});

test('parses boolean environment flags explicitly', () => {
  assert.equal(envFlag('true'), true);
  assert.equal(envFlag('0', true), false);
  assert.equal(envFlag(undefined, true), true);
});

test('clamps pagination integers and rejects non-integers', () => {
  assert.equal(boundedInteger('-5', 20, 1, 100), 1);
  assert.equal(boundedInteger('500', 20, 1, 100), 100);
  assert.equal(boundedInteger('1.5', 20, 1, 100), 20);
});
