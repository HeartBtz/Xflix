const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { pool, clearAll, togglePerformerFavorite, toggleMediaFavorite, incrementViewCount, updateThumb } = require('../db');
const { scanDirectory, getProgress, cancelScan, generateVideoThumb, generatePhotoThumb, enrichDurations } = require('../scanner');

const MEDIA_DIR = process.env.MEDIA_DIR || '/home/coder/OF';

/* ─── Performers ─────────────────────────────────────────────── */

// GET /api/performers?q=&sort=name|video_count|photo_count|total_size&order=asc|desc&favorite=1
router.get('/performers', async (req, res) => {
  try {
    const { q = '', sort = 'name', order = 'asc', minVideos, minPhotos, favorite, limit: lim, offset: off } = req.query;

    const allowed = ['name', 'video_count', 'photo_count', 'total_size', 'updated_at', 'favorite'];
    const sortCol = allowed.includes(sort) ? sort : 'name';
    const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

    let query = `SELECT p.*, COALESCE(
      (SELECT id FROM media WHERE performer_id = p.id AND type = 'photo' ORDER BY RAND() LIMIT 1),
      (SELECT id FROM media WHERE performer_id = p.id ORDER BY RAND() LIMIT 1)
    ) AS random_cover_id FROM performers p WHERE 1=1`;
    const params = [];

    if (q) { query += ` AND p.name LIKE ?`; params.push(`%${q}%`); }
    if (minVideos) { query += ` AND p.video_count >= ?`; params.push(Number(minVideos)); }
    if (minPhotos) { query += ` AND p.photo_count >= ?`; params.push(Number(minPhotos)); }
    if (favorite === '1') { query += ` AND p.favorite = 1`; }

    // Separate count query (avoids multi-line regex issues)
    let countQuery = `SELECT COUNT(*) as cnt FROM performers p WHERE 1=1`;
    if (q) countQuery += ` AND p.name LIKE ?`;
    if (minVideos) countQuery += ` AND p.video_count >= ?`;
    if (minPhotos) countQuery += ` AND p.photo_count >= ?`;
    if (favorite === '1') countQuery += ` AND p.favorite = 1`;
    const [countRows] = await pool.query(countQuery, params);
    const total = countRows[0].cnt;

    let dataQuery = `${query} ORDER BY p.${sortCol} ${sortOrder}`;
    const dataParams = [...params];
    if (lim) { dataQuery += ` LIMIT ?`; dataParams.push(Number(lim)); if (off) { dataQuery += ` OFFSET ?`; dataParams.push(Number(off)); } }

    const [performers] = await pool.query(dataQuery, dataParams);
    res.json({ data: performers, total });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/performers/:name
router.get('/performers/:name', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM performers WHERE name = ?', [req.params.name]);
    if (!rows.length) return res.status(404).json({ error: 'Performer not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/performers/:id/favorite
router.post('/performers/:id/favorite', async (req, res) => {
  try {
    const result = await togglePerformerFavorite(Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Performer not found' });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ─── Media ──────────────────────────────────────────────────── */

// GET /api/performers/:name/videos
router.get('/performers/:name/videos', async (req, res) => {
  try {
    const [pRows] = await pool.query('SELECT id FROM performers WHERE name = ?', [req.params.name]);
    if (!pRows.length) return res.status(404).json({ error: 'Performer not found' });
    const pId = pRows[0].id;

    const { sort = 'filename', order = 'asc', minSize, maxSize, minDuration, maxDuration, favorite, page = 1, limit = 50 } = req.query;
    const allowed = ['filename', 'size', 'duration', 'created_at', 'view_count', 'favorite'];
    const sortCol = allowed.includes(sort) ? sort : 'filename';
    const sortOrder = order === 'desc' ? 'DESC' : 'ASC';
    const offset = (Number(page) - 1) * Number(limit);

    let query = `SELECT * FROM media WHERE performer_id = ? AND type = 'video'`;
    const params = [pId];

    if (minSize) { query += ` AND size >= ?`; params.push(Number(minSize)); }
    if (maxSize) { query += ` AND size <= ?`; params.push(Number(maxSize)); }
    if (minDuration) { query += ` AND duration >= ?`; params.push(Number(minDuration)); }
    if (maxDuration) { query += ` AND duration <= ?`; params.push(Number(maxDuration)); }
    if (favorite === '1') { query += ` AND favorite = 1`; }

    const [countRows] = await pool.query(query.replace('SELECT *', 'SELECT COUNT(*) as cnt'), params);
    const total = countRows[0].cnt;

    const [videos] = await pool.query(`${query} ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`, [...params, Number(limit), offset]);
    res.json({ data: videos, total, page: Number(page), limit: Number(limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/performers/:name/photos
router.get('/performers/:name/photos', async (req, res) => {
  try {
    const [pRows] = await pool.query('SELECT id FROM performers WHERE name = ?', [req.params.name]);
    if (!pRows.length) return res.status(404).json({ error: 'Performer not found' });
    const pId = pRows[0].id;

    const { sort = 'filename', order = 'asc', page = 1, limit = 100, favorite } = req.query;
    const allowed = ['filename', 'size', 'created_at', 'view_count', 'favorite'];
    const sortCol = allowed.includes(sort) ? sort : 'filename';
    const sortOrder = order === 'desc' ? 'DESC' : 'ASC';
    const offset = (Number(page) - 1) * Number(limit);

    let query = `SELECT * FROM media WHERE performer_id = ? AND type = 'photo'`;
    const params = [pId];
    if (favorite === '1') { query += ` AND favorite = 1`; }

    const [countRows] = await pool.query(query.replace('SELECT *', 'SELECT COUNT(*) as cnt'), params);
    const total = countRows[0].cnt;

    const [photos] = await pool.query(`${query} ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`, [...params, Number(limit), offset]);
    res.json({ data: photos, total, page: Number(page), limit: Number(limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/media/:id
router.get('/media/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT m.*, p.name AS performer_name FROM media m JOIN performers p ON p.id = m.performer_id WHERE m.id = ?',
      [Number(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/media/:id/favorite
router.post('/media/:id/favorite', async (req, res) => {
  try {
    const result = await toggleMediaFavorite(Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Media not found' });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/media/:id/view
router.post('/media/:id/view', async (req, res) => {
  try {
    await incrementViewCount(Number(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ─── Global Search ──────────────────────────────────────────── */

router.get('/search', async (req, res) => {
  try {
    const { q = '', type, minSize, maxSize, minDuration, maxDuration, favorite, sort = 'filename', order = 'asc', page = 1, limit = 60 } = req.query;
    const allowed = ['filename', 'size', 'duration', 'created_at', 'view_count'];
    const sortCol = allowed.includes(sort) ? sort : 'filename';
    const sortOrder = order === 'desc' ? 'DESC' : 'ASC';
    const offset = (Number(page) - 1) * Number(limit);

    let query = `SELECT m.*, p.name AS performer_name FROM media m JOIN performers p ON p.id = m.performer_id WHERE 1=1`;
    const params = [];

    if (q) { query += ` AND (m.filename LIKE ? OR p.name LIKE ?)`; params.push(`%${q}%`, `%${q}%`); }
    if (type && ['video', 'photo'].includes(type)) { query += ` AND m.type = ?`; params.push(type); }
    if (minSize) { query += ` AND m.size >= ?`; params.push(Number(minSize)); }
    if (maxSize) { query += ` AND m.size <= ?`; params.push(Number(maxSize)); }
    if (minDuration) { query += ` AND m.duration >= ?`; params.push(Number(minDuration)); }
    if (maxDuration) { query += ` AND m.duration <= ?`; params.push(Number(maxDuration)); }
    if (favorite === '1') { query += ` AND m.favorite = 1`; }

    const [countRows] = await pool.query(query.replace('SELECT m.*, p.name AS performer_name', 'SELECT COUNT(*) as cnt'), params);
    const total = countRows[0].cnt;

    const [items] = await pool.query(`${query} ORDER BY m.${sortCol} ${sortOrder} LIMIT ? OFFSET ?`, [...params, Number(limit), offset]);
    res.json({ data: items, total, page: Number(page), limit: Number(limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ─── Random / Discover ──────────────────────────────────────── */

router.get('/random/videos', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    // Subquery on the index only, then JOIN — much faster than ORDER BY RAND() on full rows
    const [videos] = await pool.query(`
      SELECT m.*, p.name AS performer_name
      FROM (SELECT id FROM media WHERE type = 'video' ORDER BY RAND() LIMIT ?) t
      JOIN media m ON m.id = t.id
      JOIN performers p ON p.id = m.performer_id
    `, [limit]);
    res.json({ data: videos });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/random/photos', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const [photos] = await pool.query(`
      SELECT m.*, p.name AS performer_name
      FROM (SELECT id FROM media WHERE type = 'photo' ORDER BY RAND() LIMIT ?) t
      JOIN media m ON m.id = t.id
      JOIN performers p ON p.id = m.performer_id
    `, [limit]);
    res.json({ data: photos });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/random/performer', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM performers ORDER BY RAND() LIMIT 1');
    if (!rows.length) return res.status(404).json({ error: 'No performers' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ─── Recently Viewed ────────────────────────────────────────── */

router.get('/recent', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const type = req.query.type;
    let query = `SELECT m.*, p.name AS performer_name FROM media m
      JOIN performers p ON p.id = m.performer_id WHERE m.last_viewed IS NOT NULL`;
    const params = [];
    if (type && ['video','photo'].includes(type)) { query += ` AND m.type = ?`; params.push(type); }
    query += ` ORDER BY m.last_viewed DESC LIMIT ?`;
    params.push(limit);
    const [rows] = await pool.query(query, params);
    res.json({ data: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ─── Most Viewed ────────────────────────────────────────────── */

router.get('/popular', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const type = req.query.type;
    let query = `SELECT m.*, p.name AS performer_name FROM media m
      JOIN performers p ON p.id = m.performer_id WHERE m.view_count > 0`;
    const params = [];
    if (type && ['video','photo'].includes(type)) { query += ` AND m.type = ?`; params.push(type); }
    query += ` ORDER BY m.view_count DESC LIMIT ?`;
    params.push(limit);
    const [rows] = await pool.query(query, params);
    res.json({ data: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ─── Favorites ──────────────────────────────────────────────── */

router.get('/favorites', async (req, res) => {
  try {
    const type = req.query.type;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 60;
    const offset = (page - 1) * limit;
    let query = `SELECT m.*, p.name AS performer_name FROM media m
      JOIN performers p ON p.id = m.performer_id WHERE m.favorite = 1`;
    const params = [];
    if (type && ['video','photo'].includes(type)) { query += ` AND m.type = ?`; params.push(type); }
    const [countRows] = await pool.query(query.replace('SELECT m.*, p.name AS performer_name', 'SELECT COUNT(*) as cnt'), params);
    const total = countRows[0].cnt;
    const [rows] = await pool.query(`${query} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    res.json({ data: rows, total, page, limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ─── Stats ──────────────────────────────────────────────────── */

router.get('/stats', async (req, res) => {
  try {
    // Single parallel batch — much faster than 8 sequential queries
    const [
      [[{ performers }]],
      [[{ videos }]],
      [[{ photos }]],
      [[{ totalSize }]],
      [[{ favorites }]],
      [[{ totalViews }]],
      [[{ favPerformers }]],
      [[{ totalDuration }]],
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) AS performers FROM performers'),
      pool.query("SELECT COUNT(*) AS videos FROM media WHERE type='video'"),
      pool.query("SELECT COUNT(*) AS photos FROM media WHERE type='photo'"),
      pool.query('SELECT COALESCE(SUM(size),0) AS totalSize FROM media'),
      pool.query('SELECT COUNT(*) AS favorites FROM media WHERE favorite = 1'),
      pool.query('SELECT COALESCE(SUM(view_count),0) AS totalViews FROM media'),
      pool.query('SELECT COUNT(*) AS favPerformers FROM performers WHERE favorite = 1'),
      pool.query("SELECT COALESCE(SUM(duration),0) AS totalDuration FROM media WHERE type='video'"),
    ]);
    res.json({
      performers, videos, photos,
      totalSize:    Number(totalSize),
      favorites,    totalViews: Number(totalViews),
      favPerformers, totalDuration: Number(totalDuration),
      mediaDir: MEDIA_DIR,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ─── Scan & Clear ───────────────────────────────────────────── */

router.post('/scan', async (req, res) => {
  const progress = getProgress();
  if (progress.running) return res.status(409).json({ error: 'Scan already in progress', progress });

  const mode = req.query.mode || req.body?.mode || 'all';
  if (!['all', 'photos', 'videos'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode: use all, photos, or videos' });
  }

  res.json({ message: 'Scan started', mode });

  // Run scan in background, then enrich video durations
  scanDirectory(mode)
    .then(() => {
      // After scan finishes, fill in durations for new videos (concurrency=3)
      if (mode === 'all' || mode === 'videos') {
        enrichDurations(3).catch(e => console.error('[enrichDurations]', e.message));
      }
    })
    .catch(e => console.error('[SCANNER ERROR]', e.message));
});

router.get('/scan/progress', (req, res) => {
  res.json(getProgress());
});

router.post('/scan/cancel', (req, res) => {
  const cancelled = cancelScan();
  if (!cancelled) return res.status(400).json({ error: 'No scan running' });
  res.json({ message: 'Cancel requested' });
});

router.post('/clear', async (req, res) => {
  try {
    const progress = getProgress();
    if (progress.running) return res.status(409).json({ error: 'Cannot clear while scan is running' });
    await clearAll();
    res.json({ message: 'Database cleared' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ─── Thumbnail Generation ───────────────────────────────────── */

router.post('/thumb/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM media WHERE id = ?', [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const media = rows[0];

    let thumbPath;
    if (media.type === 'video') {
      thumbPath = await generateVideoThumb(media.file_path, media.id);
    } else {
      thumbPath = await generatePhotoThumb(media.file_path, media.id);
    }

    if (!thumbPath) return res.status(500).json({ error: 'Thumbnail generation failed' });

    await updateThumb(media.id, thumbPath);
    res.json({ thumbPath });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
