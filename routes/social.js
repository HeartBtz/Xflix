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
const { requireAuth, optionalAuth } = require('../middleware/auth');

/* ══════════════════════════════════════════════════════════════════
   COMMENTS
   ══════════════════════════════════════════════════════════════════ */

// GET /social/comments/:mediaId — public
router.get('/comments/:mediaId', optionalAuth, async (req, res) => {
  try {
    const mediaId = Number(req.params.mediaId);
    const page   = Number(req.query.page)  || 1;
    const limit  = Math.min(Number(req.query.limit) || 20, 100);
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
    const content = rawContent?.trim();
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
    const content = rawContent?.trim();
    if (!content) return res.status(400).json({ error: 'content required' });
    if (content.length > 2000) return res.status(400).json({ error: 'Comment too long' });

    const [[comment]] = await pool.query('SELECT * FROM comments WHERE id = ?', [id]);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not allowed' });
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
    if (comment.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not allowed' });
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
    const { type } = req.body || {};
    if (!['like', 'dislike'].includes(type)) return res.status(400).json({ error: "type must be 'like' or 'dislike'" });

    const [[existing]] = await pool.query(
      'SELECT id, type FROM media_reactions WHERE user_id = ? AND media_id = ?',
      [req.user.id, mediaId]
    );

    if (existing) {
      if (existing.type === type) {
        // Toggle off
        await pool.query('DELETE FROM media_reactions WHERE id = ?', [existing.id]);
      } else {
        // Switch reaction
        await pool.query('UPDATE media_reactions SET type = ? WHERE id = ?', [type, existing.id]);
      }
    } else {
      await pool.query(
        'INSERT INTO media_reactions (user_id, media_id, type) VALUES (?, ?, ?)',
        [req.user.id, mediaId, type]
      );
    }

    // Return updated counts in one query
    const [[counts]] = await pool.query(
      "SELECT SUM(type='like') as likes, SUM(type='dislike') as dislikes FROM media_reactions WHERE media_id = ?",
      [mediaId]
    );
    const [[row]] = await pool.query(
      'SELECT type FROM media_reactions WHERE user_id = ? AND media_id = ?',
      [req.user.id, mediaId]
    );
    res.json({ likes: counts.likes || 0, dislikes: counts.dislikes || 0, userReaction: row?.type || null });
  } catch(e) { console.error('[SOCIAL]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

/* ══════════════════════════════════════════════════════════════════
   USER FAVORITES (per-user)
   ══════════════════════════════════════════════════════════════════ */

// GET /social/favorites — user's favorited media
router.get('/favorites', requireAuth, async (req, res) => {
  try {
    const type = req.query.type;
    const page = Number(req.query.page) || 1;
    const limit = Math.min(Number(req.query.limit) || 60, 200);
    const offset = (page - 1) * limit;

    let q = `SELECT m.*, p.name AS performer_name FROM user_favorites uf
             JOIN media m ON m.id = uf.media_id
             JOIN performers p ON p.id = m.performer_id
             WHERE uf.user_id = ?`;
    const params = [req.user.id];
    if (type && ['video','photo'].includes(type)) { q += ' AND m.type = ?'; params.push(type); }

    const [[{ total }]] = await pool.query(q.replace(/SELECT m\.\*.*WHERE/, 'SELECT COUNT(*) as total FROM user_favorites uf JOIN media m ON m.id = uf.media_id WHERE'), params);
    const [rows] = await pool.query(`${q} ORDER BY uf.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    res.json({ data: rows, total, page, limit });
  } catch(e) { console.error('[SOCIAL]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /social/favorites/:mediaId — toggle user favorite
router.post('/favorites/:mediaId', requireAuth, async (req, res) => {
  try {
    const mediaId = Number(req.params.mediaId);
    const [[existing]] = await pool.query(
      'SELECT 1 FROM user_favorites WHERE user_id = ? AND media_id = ?',
      [req.user.id, mediaId]
    );
    if (existing) {
      await pool.query('DELETE FROM user_favorites WHERE user_id = ? AND media_id = ?', [req.user.id, mediaId]);
      res.json({ favorited: false });
    } else {
      await pool.query('INSERT INTO user_favorites (user_id, media_id) VALUES (?, ?)', [req.user.id, mediaId]);
      res.json({ favorited: true });
    }
  } catch(e) { console.error('[SOCIAL]', e.message); res.status(500).json({ error: 'Internal server error' }); }
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
