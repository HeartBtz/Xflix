/**
 * routes/auth.js — Authentication & account management
 *
 * Mounted under /auth in server.js. Uses short-lived HS256 JWT sessions in a
 * host-only HttpOnly cookie with a database-backed revocation version.
 *
 * Endpoint summary
 * ────────────────
 *   POST /auth/register         — create account (first user → admin)
 *   POST /auth/login            — validate credentials, start session
 *   GET  /auth/me               — return current user profile (requires auth)
 *   POST /auth/change-password  — change password (requires auth)
 *   POST /auth/forgot-password  — send reset email
 *   POST /auth/reset-password   — consume reset token, set new password
 *   GET  /auth/config           — public: is registration open?
 *   PUT  /auth/profile          — update username / bio (requires auth)
 *
 * Security notes
 * ──────────────
 *   - Passwords are hashed with bcrypt (cost factor 12).
 *   - forgot-password always returns 200 to prevent email enumeration.
 *   - Reset tokens expire after 1 hour.
 *   - JWT_SECRET must be changed in production (see .env.example).
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const {
  getUserByEmail, getUserById,
  setResetToken, consumeResetToken, changeUserPassword, revokeUserSessions, withUserLock, updateLastLogin, updateUserProfile,
  getSetting, pool
} = require('../db');
const {
  signToken, requireAuth, optionalAuth, requireSameOrigin, setSessionCookie, clearSessionCookie, REQUIRE_CONTENT_AUTH,
} = require('../middleware/auth');
const { sendPasswordReset } = require('../services/mail');
const { validateBaseUrl } = require('../lib/security');
const DUMMY_PASSWORD_HASH = '$2b$12$2aNhp3mTFv3.UVxjuhKZtecbasr.NV/I1rDbDuSI9/TJ/CU46ZIE6';

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(requireSameOrigin);

function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && !bcrypt.truncates(password);
}

function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function startSession(req, res, user) {
  const token = signToken(user);
  setSessionCookie(req, res, token);
  return token;
}

// Limite uniquement les routes exposées au brute-force
// (/config et /me ne sont pas limités — ils sont appelés à chaque chargement)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 30,                    // 30 tentatives par fenêtre
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — try again later' },
});

/* ── Register ─────────────────────────────────────────────────── */
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: 'username, email, password required' });
    const normalizedUsername = typeof username === 'string' ? username.trim() : '';
    if (normalizedUsername.length < 2 || normalizedUsername.length > 50) return res.status(400).json({ error: 'Username must be 2-50 characters' });
    if (!/^[a-zA-Z0-9_\-. àâäéèêëïîôùûüÿçÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ]+$/.test(normalizedUsername)) return res.status(400).json({ error: 'Username contains invalid characters' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Password must have at least 12 characters and at most 72 UTF-8 bytes' });

    const hash = await bcrypt.hash(password, 12);
    // Bootstrap only an empty installation, never existing users that lost their admin.
    const { id, role } = await withUserLock(async conn => {
      const [[{ users }]] = await conn.query('SELECT COUNT(*) AS users FROM users');
      const [[setting]] = await conn.query("SELECT value FROM settings WHERE `key` = 'allow_registration'");
      const allowReg = setting?.value ?? (users === 0 ? 'true' : 'false');
      if (allowReg !== 'true') throw Object.assign(new Error('Registration is closed. Contact an admin.'), { status: 403 });
      const role = users === 0 ? 'admin' : 'member';
      const [created] = await conn.query(
        'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
        [normalizedUsername, email.toLowerCase(), hash, role],
      );
      return { id: created.insertId, role };
    });
    await updateLastLogin(id);

    const user = { id, username: normalizedUsername, email: email.toLowerCase(), role };
    startSession(req, res, user);
    res.status(201).json({ user });
  } catch(e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username or email already in use' });
    console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' });
  }
});

/* ── Login ────────────────────────────────────────────────────── */
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!validEmail(email) || typeof password !== 'string' || password.length > 128) return res.status(400).json({ error: 'Invalid email or password' });

    const user = await getUserByEmail(email.toLowerCase());
    const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_PASSWORD_HASH);
    if (!user || !ok) return res.status(401).json({ error: 'Invalid email or password' });

    await updateLastLogin(user.id);
    startSession(req, res, user);
    res.json({ user: { id: user.id, username: user.username, email: user.email, role: user.role, avatar: user.avatar, bio: user.bio } });
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ── Me (profile) ─────────────────────────────────────────────── */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password_hash, reset_token, reset_expires, session_version, ...safe } = user;
    res.json(safe);
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ── Change password (authenticated) ────────────────────────────── */
router.post('/change-password', requireAuth, authLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || currentPassword.length > 128 || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' });
    if (!validPassword(newPassword)) return res.status(400).json({ error: 'Password must have at least 12 characters and at most 72 UTF-8 bytes' });

    const user = await getUserById(req.user.id);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    if (!await changeUserPassword(req.user.id, user.password_hash, hash, req.user.session_version)) {
      return res.status(409).json({ error: 'Account changed. Please sign in again.' });
    }
    clearSessionCookie(req, res);
    res.json({ message: 'Password updated. Please sign in again.' });
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ── Forgot password ──────────────────────────────────────────── */
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'Invalid email format' });

    const user = await getUserByEmail(email.toLowerCase());
    // Always return 200 to avoid email enumeration
    if (!user) return res.json({ message: 'If the email exists, a reset link has been sent.' });

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600 * 1000); // 1h
    await setResetToken(user.id, token, expires);

    const baseUrl = validateBaseUrl(process.env.BASE_URL);
    if (!baseUrl) {
      console.error('[AUTH] Password reset requested but BASE_URL is not configured.');
      return res.json({ message: 'If the email exists, a reset link has been sent.' });
    }
    const resetUrl = `${baseUrl}/reset-password?token=${token}`;

    try {
      await sendPasswordReset(user.email, user.username, resetUrl);
    } catch(mailErr) {
      console.error('[MAIL ERROR]', mailErr.message);
    }

    res.json({ message: 'If the email exists, a reset link has been sent.' });
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ── Reset password ────────────────────────────────────────────── */
router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !newPassword) return res.status(400).json({ error: 'Invalid or expired reset token' });
    if (!validPassword(newPassword)) return res.status(400).json({ error: 'Password must have at least 12 characters and at most 72 UTF-8 bytes' });

    const hash = await bcrypt.hash(newPassword, 12);
    if (!await consumeResetToken(token, hash)) return res.status(400).json({ error: 'Invalid or expired reset token' });
    clearSessionCookie(req, res);
    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ── Public config (registration open?) ─────────────────────────── */
router.get('/config', async (req, res) => {
  try {
    const [[{ cnt }]] = await pool.query('SELECT COUNT(*) as cnt FROM users');
    const allowReg = await getSetting('allow_registration', cnt === 0 ? 'true' : 'false');
    res.json({
      allow_registration: allowReg === 'true',
      has_users: cnt > 0,
      require_auth: REQUIRE_CONTENT_AUTH,
    });
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ── Update profile (authenticated) ─────────────────────────────── */
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { username, bio } = req.body || {};
    if (username !== undefined) {
      if (typeof username !== 'string' || username.trim().length < 2 || username.trim().length > 50) return res.status(400).json({ error: 'Username must be 2-50 characters' });
      if (!/^[a-zA-Z0-9_\-. àâäéèêëïîôùûüÿçÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ]+$/.test(username)) return res.status(400).json({ error: 'Username contains invalid characters' });
      // Check uniqueness
      const [[exists]] = await pool.query(
        'SELECT id FROM users WHERE username = ? AND id != ?', [username.trim(), req.user.id]
      );
      if (exists) return res.status(409).json({ error: 'Username already taken' });
    }
    if (bio !== undefined && (typeof bio !== 'string' || bio.length > 1000)) return res.status(400).json({ error: 'Bio must not exceed 1000 characters' });
    await updateUserProfile(req.user.id, {
      username: username?.trim(),
      bio: bio?.trim(),
    });
    const user = await getUserById(req.user.id);
    const { password_hash, reset_token, reset_expires, session_version, ...safe } = user;
    res.json(safe);
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/logout', optionalAuth, async (req, res) => {
  try {
    if (req.user) await revokeUserSessions(req.user.id, req.user.session_version);
    clearSessionCookie(req, res);
    res.json({ message: 'Signed out on all devices' });
  } catch (_) { res.status(503).json({ error: 'Unable to revoke sessions. Please retry.' }); }
});

module.exports = router;
