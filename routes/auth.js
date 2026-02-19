/**
 * routes/auth.js — Authentication & account management
 *
 * Mounted under /auth in server.js. Uses JWT (HS256) stored client-side
 * in localStorage. No server-side sessions — stateless by design.
 *
 * Endpoint summary
 * ────────────────
 *   POST /auth/register         — create account (first user → admin)
 *   POST /auth/login            — validate credentials, return JWT
 *   GET  /auth/me               — return current user profile (requires auth)
 *   POST /auth/change-password  — change password (requires auth)
 *   POST /auth/forgot-password  — send reset email (or return link in dev)
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
const {
  createUser, getUserByEmail, getUserById, getUserByResetToken,
  setResetToken, clearResetToken, updateLastLogin, updateUserProfile,
  getSetting, countAdmins, pool
} = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { sendPasswordReset } = require('../services/mail');

/* ── Register ─────────────────────────────────────────────────── */
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: 'username, email, password required' });
    if (typeof username !== 'string' || username.length < 2 || username.length > 50) return res.status(400).json({ error: 'Username must be 2-50 characters' });
    if (!/^[a-zA-Z0-9_\-. àâäéèêëïîôùûüÿçÀÂÄÉÈÊËÏÎÔÙÛÜŸÇ]+$/.test(username)) return res.status(400).json({ error: 'Username contains invalid characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Check if registration is open or if this is the first user (becomes admin)
    const allowReg = await getSetting('allow_registration', 'true');
    const admins = await countAdmins();
    if (allowReg !== 'true' && admins > 0) {
      return res.status(403).json({ error: 'Registration is closed. Contact an admin.' });
    }

    const hash = await bcrypt.hash(password, 12);
    // First-ever user gets admin role
    const role = admins === 0 ? 'admin' : 'member';
    const id = await createUser(username, email.toLowerCase(), hash, role);
    await updateLastLogin(id);

    const token = signToken({ id, username, role });
    res.status(201).json({ token, user: { id, username, email: email.toLowerCase(), role } });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username or email already in use' });
    console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' });
  }
});

/* ── Login ────────────────────────────────────────────────────── */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const user = await getUserByEmail(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    await updateLastLogin(user.id);
    const token = signToken({ id: user.id, username: user.username, role: user.role });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role, avatar: user.avatar } });
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ── Me (profile) ─────────────────────────────────────────────── */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password_hash, reset_token, reset_expires, ...safe } = user;
    res.json(safe);
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ── Change password (authenticated) ────────────────────────────── */
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const user = await getUserById(req.user.id);
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    await clearResetToken(req.user.id, hash);
    res.json({ message: 'Password updated' });
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ── Forgot password ──────────────────────────────────────────── */
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    const user = await getUserByEmail(email.toLowerCase());
    // Always return 200 to avoid email enumeration
    if (!user) return res.json({ message: 'If the email exists, a reset link has been sent.' });

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600 * 1000); // 1h
    await setResetToken(user.id, token, expires);

    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const resetUrl = `${baseUrl}/reset-password?token=${token}`;

    try {
      await sendPasswordReset(user.email, user.username, resetUrl);
    } catch(mailErr) {
      console.error('[MAIL ERROR]', mailErr.message);
      // Log the URL server-side for dev recovery — never expose to client
      console.info('[DEV] Reset URL:', resetUrl);
    }

    res.json({ message: 'If the email exists, a reset link has been sent.' });
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ── Reset password ────────────────────────────────────────────── */
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const user = await getUserByResetToken(token);
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const hash = await bcrypt.hash(newPassword, 12);
    await clearResetToken(user.id, hash);
    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ── Public config (registration open?) ─────────────────────────── */
router.get('/config', async (req, res) => {
  try {
    const allowReg = await getSetting('allow_registration', 'true');
    const [[{ cnt }]] = await pool.query('SELECT COUNT(*) as cnt FROM users');
    res.json({
      allow_registration: allowReg !== 'false',
      has_users: cnt > 0,
    });
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ── Update profile (authenticated) ─────────────────────────────── */
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { username, bio } = req.body || {};
    if (username !== undefined) {
      if (username.trim().length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
      // Check uniqueness
      const [[exists]] = await pool.query(
        'SELECT id FROM users WHERE username = ? AND id != ?', [username.trim(), req.user.id]
      );
      if (exists) return res.status(409).json({ error: 'Username already taken' });
    }
    await updateUserProfile(req.user.id, {
      username: username?.trim(),
      bio: bio?.trim(),
    });
    const user = await getUserById(req.user.id);
    const { password_hash, reset_token, reset_expires, ...safe } = user;
    res.json(safe);
  } catch(e) { console.error('[AUTH]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
