/**
 * middleware/auth.js — JWT authentication helpers
 *
 * Exports three Express middleware functions and two JWT utilities:
 *
 *   optionalAuth  — Decodes the JWT if present. Sets req.user.
 *                    Never blocks — safe to use on public routes.
 *
 *   requireAuth   — Returns 401 if no valid JWT is provided.
 *                    Sets req.user on success.
 *
 *   requireAdmin  — Calls requireAuth, then checks role === ‘admin’.
 *                    Returns 403 if the user is not an admin.
 *
 *   signToken(payload)   — Create a signed JWT.
 *   verifyToken(token)   — Verify and decode a JWT (throws on failure).
 *
 * The JWT_SECRET must be set via the JWT_SECRET environment variable in
 * production. The default fallback is intentionally weak and should not
 * be used outside of local development.
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getUserById } = require('../db');

// Generate a random secret if none provided — survives the process lifetime
// but rotates on restart (forces re-login). This is intentional: it avoids
// shipping a hardcoded secret while still working out-of-the-box.
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const generated = crypto.randomBytes(64).toString('hex');
  console.warn('  ⚠️  JWT_SECRET non défini — clé aléatoire générée (les sessions expireront au redémarrage).');
  console.warn('  ⚠️  Définissez JWT_SECRET dans .env pour des sessions persistantes.');
  return generated;
})();
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Middleware: extract JWT from Authorization header.
 * Sets req.user if valid. Never blocks — use requireAuth/requireAdmin for that.
 */
async function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return next();
  try {
    const decoded = verifyToken(auth.slice(7));
    req.user = { id: decoded.id, username: decoded.username, role: decoded.role };
  } catch(e) { /* invalid/expired token — proceed without user */ }
  next();
}

/** Middleware: require authenticated user */
function requireAuth(req, res, next) {
  let tokenStr = null;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    tokenStr = auth.slice(7);
  } else if (req.query?.token) {
    // Allow token via query param (needed for EventSource SSE which can't set headers)
    tokenStr = req.query.token;
  }
  if (!tokenStr) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = verifyToken(tokenStr);
    req.user = { id: decoded.id, username: decoded.username, role: decoded.role };
    next();
  } catch(e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Middleware: require admin role */
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

module.exports = { signToken, verifyToken, optionalAuth, requireAuth, requireAdmin };
