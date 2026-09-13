'use strict';

const crypto = require('crypto');

function envFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function validateBaseUrl(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('BASE_URL must be a valid absolute URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('BASE_URL must use http or https');
  if (url.username || url.password || url.search || url.hash) throw new Error('BASE_URL must not contain credentials, a query, or a fragment');
  return url.origin + url.pathname.replace(/\/$/, '');
}

function parseByteRange(header, fileSize) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(fileSize) || fileSize < 0) return false;

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : fileSize - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= fileSize || end < start) return false;
  return { start, end: Math.min(end, fileSize - 1) };
}

function boundedInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

module.exports = { envFlag, hashResetToken, validateBaseUrl, parseByteRange, boundedInteger };
