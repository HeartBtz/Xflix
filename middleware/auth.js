/** Authentication, session-cookie and request-origin guards. */
'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getUserById } = require('../db');
const { envFlag } = require('../lib/security');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const configuredSecret = process.env.JWT_SECRET;
if (IS_PRODUCTION && (!configuredSecret || configuredSecret.length < 32)) {
  throw new Error('JWT_SECRET must contain at least 32 characters in production');
}
const JWT_SECRET = configuredSecret || crypto.randomBytes(64).toString('hex');
if (!configuredSecret) console.warn('  ⚠️  JWT_SECRET absent: temporary development sessions will be invalidated on restart.');

const JWT_EXPIRES = process.env.JWT_EXPIRES || '12h';
const JWT_ISSUER = 'xflix';
const JWT_AUDIENCE = 'xflix-web';
const COOKIE_NAME = 'xflix_session';
if (process.env.REQUIRE_AUTH && !/^(true|false|1|0|yes|no|on|off)$/i.test(process.env.REQUIRE_AUTH.trim())) {
  throw new Error('REQUIRE_AUTH must be an explicit boolean');
}
const REQUIRE_CONTENT_AUTH = envFlag(process.env.REQUIRE_AUTH, true);

function signToken(payload) {
  return jwt.sign(
    { sv: payload.session_version ?? 0 },
    JWT_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: JWT_EXPIRES,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      subject: String(payload.id),
    },
  );
}

function verifyToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  const id = Number(decoded.sub);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid token subject');
  if (!Number.isSafeInteger(decoded.sv) || decoded.sv < 0) throw new Error('Invalid session version');
  return { ...decoded, id };
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    try { cookies[key] = decodeURIComponent(part.slice(separator + 1).trim()); } catch (_) {}
  }
  return cookies;
}

function getRequestToken(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return { token: auth.slice(7), source: 'bearer' };
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  return token ? { token, source: 'cookie' } : null;
}

function sessionCookie(req, token, clear = false) {
  const secureOverride = process.env.COOKIE_SECURE;
  const secure = secureOverride === undefined ? Boolean(req.secure) : envFlag(secureOverride);
  const parts = [
    `${COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : '',
  ].filter(Boolean);
  if (clear) parts.push('Max-Age=0');
  else {
    const decoded = jwt.decode(token);
    const seconds = Math.max(0, Number(decoded?.exp || 0) - Math.floor(Date.now() / 1000));
    parts.push(`Max-Age=${seconds}`);
  }
  return parts.join('; ');
}

function setSessionCookie(req, res, token) {
  res.append('Set-Cookie', sessionCookie(req, token));
}

function clearSessionCookie(req, res) {
  res.append('Set-Cookie', sessionCookie(req, '', true));
}

async function decodeRequest(req) {
  const found = getRequestToken(req);
  if (!found) return null;
  let decoded;
  try { decoded = verifyToken(found.token); }
  catch (_) { throw Object.assign(new Error('Invalid or expired session'), { status: 401 }); }
  const user = await getUserById(decoded.id);
  if (!user || user.session_version !== decoded.sv) {
    throw Object.assign(new Error('Invalid or expired session'), { status: 401 });
  }
  req.authToken = found.token;
  req.authSource = found.source;
  req.user = { id: user.id, username: user.username, role: user.role, session_version: user.session_version };
  return decoded;
}

async function optionalAuth(req, res, next) {
  try { await decodeRequest(req); }
  catch (error) {
    delete req.user;
    if (error.status !== 401) return res.status(503).json({ error: 'Authentication service unavailable' });
  }
  return next();
}

async function requireAuth(req, res, next) {
  try {
    if (!await decodeRequest(req)) return res.status(401).json({ error: 'Authentication required' });
  } catch (error) {
    if (error.status !== 401) return res.status(503).json({ error: 'Authentication service unavailable' });
    clearSessionCookie(req, res);
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  return next();
}

function requireContentAuth(req, res, next) {
  if (!REQUIRE_CONTENT_AUTH) return optionalAuth(req, res, next);
  return requireAuth(req, res, next);
}

function requireSameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    return res.status(403).json({ error: 'Cross-site request rejected' });
  }
  const origin = req.get('origin');
  if (origin) {
    let expected;
    try { expected = new URL(process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).origin; } catch (_) {
      return res.status(500).json({ error: 'Invalid server origin configuration' });
    }
    if (origin !== expected) return res.status(403).json({ error: 'Request origin rejected' });
  }
  next();
}

function requireAdmin(req, res, next) {
  return requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    return next();
  });
}

module.exports = {
  signToken, verifyToken, optionalAuth, requireAuth, requireContentAuth, requireSameOrigin,
  requireAdmin, setSessionCookie, clearSessionCookie, REQUIRE_CONTENT_AUTH,
};
