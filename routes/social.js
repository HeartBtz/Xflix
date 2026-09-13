/**
 * routes/social.js — Social features: comments, reactions, per-user favourites
 *
 * Mounted under /social in server.js.
 *
 * Endpoint summary
 * ────────────────
 * Comments
 *   GET    /social/comments/:mediaId  — paginated comment list (public)
 *   POST   /social/comments/:mediaId  — post a comment (auth required)
 *   PATCH  /social/comments/:id       — edit own comment (or admin)
 *   DELETE /social/comments/:id       — delete own comment (or admin)
 *
 * Reactions
 *   GET  /social/reactions/:mediaId   — like/dislike counts + user’s own (public)
 *   POST /social/reactions/:mediaId   — add / toggle reaction (auth required)
 *
 * Per-user Favourites
 *   GET  /social/favorites            — current user’s favourited media
 *   POST /social/favorites/:mediaId   — toggle a media as user-favourite
 *   GET  /social/favorites/:mediaId   — check if user has favourited a media
 *
 * Note: there are TWO types of favourites:
 *   • Global  — media.favorite column (admin-level, shown to everyone)
 *   • Per-user — user_favorites table (personal, requires login)
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, optionalAuth, requireContentAuth, requireSameOrigin } = require('../middleware/auth');
const { boundedInteger } = require('../lib/security');

router.use(requireContentAuth, requireSameOrigin);

async function withMediaTransaction(mediaId, operation) {
  if (!Number.isSafeInteger(mediaId) || mediaId < 1) throw Object.assign(new Error('Invalid media ID'), { status: 400 });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // Lock the parent even when no reaction/favorite row exists yet.
    const [[media]] = await connection.query('SELECT id FROM media WHERE id = ? FOR UPDATE', [mediaId]);
    if (!media) throw Object.assign(new Error('Media not found'), { status: 404 });
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch (_) { connection.destroy(); }
    throw error;
  } finally { connection.release(); }
}

/* ══════════════════════════════════════════════════════════════════
   COMMENTS
   ══════════════════════════════════════════════════════════════════ */

// GET /social/comments/:mediaId — public
router.get('/comments/:mediaId', optionalAuth, async (req, res) => {
  try {
    const mediaId = Number(req.params.mediaId);
    const page   = boundedInteger(req.query.page, 1, 1, 1_000_000);
    const limit  = boundedInteger(req.query.limit, 20, 1, 100);
    const offset = (page - 1) * limit;

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) as total FROM comments WHERE media_id = ?', [mediaId]
    );
    const [rows] = await pool.query(
      `SELECT c.id, c.content, c.created_at, c.updated_at,
              u.id as user_id, u.username, u.avatar, u.role
       FROM comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.media_id = ?
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`,
      [mediaId, limit, offset]
    );
    res.json({ data: rows, total, page, limit });
  } catch(e) { console.error('[SOCIAL]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /social/comments/:mediaId — auth required
router.post('/comments/:mediaId', requireAuth, async (req, res) => {
  try {
    const mediaId = Number(req.params.mediaId);
    const { content: rawContent } = req.body || {};
    // Strip HTML tags to prevent stored XSS
    const content = typeof rawContent === 'string' ? rawContent.trim().replace(/<[^>]*>/g, '') : '';
    if (!content) return res.status(400).json({ error: 'content required' });
    if (content.length > 2000) return res.status(400).json({ error: 'Comment too long (max 2000 chars)' });

    // Verify media exists
    const [[row]] = await pool.query('SELECT id FROM media WHERE id = ?', [mediaId]);
    if (!row) return res.status(404).json({ error: 'Media not found' });

    const [result] = await pool.query(
      'INSERT INTO comments (user_id, media_id, content) VALUES (?, ?, ?)',
      [req.user.id, mediaId, content]
    );

    const [[comment]] = await pool.query(
      `SELECT c.id, c.content, c.created_at, c.updated_at,
              u.id as user_id, u.username, u.avatar, u.role
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.id = ?`,
      [result.insertId]
    );
    res.status(201).json(comment);
  } catch(e) { console.error('[SOCIAL]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// PATCH /social/comments/:id — edit own comment (or admin)
router.patch('/comments/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { content: rawContent } = req.body || {};
    const content = typeof rawContent === 'string' ? rawContent.trim().replace(/<[^>]*>/g, '') : '';
    if (!content) return res.status(400).json({ error: 'content required' });
    if (content.length > 2000) return res.status(400).json({ error: 'Comment too long' });

    const [[comment]] = await pool.query('SELECT * FROM comments WHERE id = ?', [id]);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.user_id !== req.user.id) {
      const [[freshUser]] = await pool.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
      if (freshUser?.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
    }

    await pool.query('UPDATE comments SET content = ? WHERE id = ?', [content, id]);
    res.json({ id, content });
  } catch(e) { console.error('[SOCIAL]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /social/comments/:id — delete own comment (or admin)
router.delete('/comments/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[comment]] = await pool.query('SELECT * FROM comments WHERE id = ?', [id]);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.user_id !== req.user.id) {
      const [[freshUser]] = await pool.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
      if (freshUser?.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
    }
    await pool.query('DELETE FROM comments WHERE id = ?', [id]);
    res.json({ message: 'Deleted' });
  } catch(e) { console.error('[SOCIAL]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ══════════════════════════════════════════════════════════════════
   REACTIONS (like / dislike)
   ══════════════════════════════════════════════════════════════════ */

// GET /social/reactions/:mediaId — counts + user's own reaction
router.get('/reactions/:mediaId', optionalAuth, async (req, res) => {
  try {
    const mediaId = Number(req.params.mediaId);
    // Single query for both counts
    const [[counts]] = await pool.query(
      "SELECT SUM(type='like') as likes, SUM(type='dislike') as dislikes FROM media_reactions WHERE media_id = ?",
      [mediaId]
    );
    let userReaction = null;
    if (req.user) {
      const [[row]] = await pool.query(
        'SELECT type FROM media_reactions WHERE user_id = ? AND media_id = ?',
        [req.user.id, mediaId]
      );
      userReaction = row?.type || null;
    }
    res.json({ likes: counts.likes || 0, dislikes: counts.dislikes || 0, userReaction });
  } catch(e) { console.error('[SOCIAL]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /social/reactions/:mediaId — add or toggle reaction
router.post('/reactions/:mediaId', requireAuth, async (req, res) => {
  try {
    const mediaId = Number(req.params.mediaId);
    const { type, active } = req.body || {};
    if (!['like', 'dislike'].includes(type)) return res.status(400).json({ error: "type must be 'like' or 'dislike'" });
    if (active !== undefined && typeof active !== 'boolean') return res.status(400).json({ error: 'active must be boolean' });

    const result = await withMediaTransaction(mediaId, async connection => {
      const [[existing]] = await connection.query(
        'SELECT id, type FROM media_reactions WHERE user_id = ? AND media_id = ?',
        [req.user.id, mediaId]
      );
      const enabled = active === undefined ? existing?.type !== type : active;
      if (!enabled) {
        await connection.query('DELETE FROM media_reactions WHERE user_id = ? AND media_id = ?', [req.user.id, mediaId]);
      } else if (existing) {
        await connection.query('UPDATE media_reactions SET type = ? WHERE id = ?', [type, existing.id]);
      } else {
        await connection.query(
          'INSERT INTO media_reactions (user_id, media_id, type) VALUES (?, ?, ?)',
          [req.user.id, mediaId, type]
        );
      }
      const [[counts]] = await connection.query(
        "SELECT SUM(type='like') as likes, SUM(type='dislike') as dislikes FROM media_reactions WHERE media_id = ?",
        [mediaId]
      );
      const [[row]] = await connection.query(
        'SELECT type FROM media_reactions WHERE user_id = ? AND media_id = ?',
        [req.user.id, mediaId]
      );
      return { likes: Number(counts.likes || 0), dislikes: Number(counts.dislikes || 0), userReaction: row?.type || null };
    });
    res.json(result);
  } catch(e) { console.error('[SOCIAL]', e.message); res.status(e.status || 500).json({ error: e.status ? e.message : 'Internal server error' }); }
});

/* ══════════════════════════════════════════════════════════════════
   USER FAVORITES (per-user)
   ══════════════════════════════════════════════════════════════════ */

// GET /social/favorites — user's favorited media
router.get('/favorites', requireAuth, async (req, res) => {
  try {
    const type = req.query.type;
    const page = boundedInteger(req.query.page, 1, 1, 1_000_000);
    const limit = boundedInteger(req.query.limit, 60, 1, 200);
    const offset = (page - 1) * limit;

    let q = `SELECT m.*, p.name AS performer_name FROM user_favorites uf
             JOIN media m ON m.id = uf.media_id
             JOIN performers p ON p.id = m.performer_id
             WHERE uf.user_id = ?`;
    const params = [req.user.id];
    if (type && ['video','photo'].includes(type)) { q += ' AND m.type = ?'; params.push(type); }

    let countQuery = `SELECT COUNT(*) AS total FROM user_favorites uf
                      JOIN media m ON m.id = uf.media_id
                      WHERE uf.user_id = ?`;
    if (type && ['video','photo'].includes(type)) countQuery += ' AND m.type = ?';
    const [[{ total }]] = await pool.query(countQuery, params);
    const [rows] = await pool.query(`${q} ORDER BY uf.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    res.json({ data: rows, total, page, limit });
  } catch(e) { console.error('[SOCIAL]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /social/favorites/:mediaId — toggle user favorite
router.post('/favorites/:mediaId', requireAuth, async (req, res) => {
  try {
    const mediaId = Number(req.params.mediaId);
    const desired = req.body?.favorited;
    if (desired !== undefined && typeof desired !== 'boolean') return res.status(400).json({ error: 'favorited must be boolean' });
    const result = await withMediaTransaction(mediaId, async connection => {
      const [[existing]] = await connection.query(
        'SELECT 1 FROM user_favorites WHERE user_id = ? AND media_id = ?',
        [req.user.id, mediaId]
      );
      const favorited = desired === undefined ? !existing : desired;
      if (!favorited) {
        await connection.query('DELETE FROM user_favorites WHERE user_id = ? AND media_id = ?', [req.user.id, mediaId]);
      } else if (!existing) {
        await connection.query('INSERT INTO user_favorites (user_id, media_id) VALUES (?, ?)', [req.user.id, mediaId]);
      }
      return { favorited };
    });
    res.json(result);
  } catch(e) { console.error('[SOCIAL]', e.message); res.status(e.status || 500).json({ error: e.status ? e.message : 'Internal server error' }); }
});

// GET /social/favorites/:mediaId — check if user favorited
router.get('/favorites/:mediaId', requireAuth, async (req, res) => {
  try {
    const [[row]] = await pool.query(
      'SELECT 1 FROM user_favorites WHERE user_id = ? AND media_id = ?',
      [req.user.id, Number(req.params.mediaId)]
    );
    res.json({ favorited: !!row });
  } catch(e) { console.error('[SOCIAL]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
