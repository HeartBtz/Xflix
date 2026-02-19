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
const { getUserById } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'xflix_super_secret_change_me_in_production';
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
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = verifyToken(auth.slice(7));
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

module.exports = { signToken, verifyToken, optionalAuth, requireAuth, requireAdmin, JWT_SECRET };
