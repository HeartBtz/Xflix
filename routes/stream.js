const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { pool, updateThumb } = require('../db');
const { generateVideoThumb, generatePhotoThumb } = require('../scanner');

const THUMB_DIR = process.env.THUMB_DIR || path.join(__dirname, '..', 'data', 'thumbs');

/**
 * Stream a video by media ID with full Range support and optimized chunking
 * GET /stream/:id
 */
router.get('/stream/:id', async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM media WHERE id = ? AND type = 'video'", [Number(req.params.id)]);
    if (!rows.length) return res.status(404).send('Not found');
    const media = rows[0];
    if (!fs.existsSync(media.file_path)) return res.status(404).send('File not found on disk');

    const stat = fs.statSync(media.file_path);
    const fileSize = stat.size;
    const range = req.headers.range;

    // ETag for cache validation
    const etag = `"${stat.ino}-${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', media.mime_type || 'video/mp4');
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=3600, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      // Default chunk: ~4MB for smooth seeking, up to file end
      const MAX_CHUNK = 4 * 1024 * 1024;
      const requestedEnd = parts[1] ? parseInt(parts[1], 10) : undefined;
      const end = requestedEnd !== undefined ? requestedEnd : Math.min(start + MAX_CHUNK, fileSize - 1);
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);

      const fileStream = fs.createReadStream(media.file_path, { start, end, highWaterMark: 256 * 1024 });
      fileStream.pipe(res);
      fileStream.on('error', () => res.end());
    } else {
      res.setHeader('Content-Length', fileSize);
      const fileStream = fs.createReadStream(media.file_path, { highWaterMark: 256 * 1024 });
      fileStream.pipe(res);
    }
  } catch(e) { res.status(500).send('Server error'); }
});

/**
 * Serve a photo by media ID
 * GET /photo/:id
 */
router.get('/photo/:id', async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT file_path, mime_type FROM media WHERE id = ? AND type = 'photo'", [Number(req.params.id)]);
    if (!rows.length) return res.status(404).send('Not found');
    const media = rows[0];
    if (!fs.existsSync(media.file_path)) return res.status(404).send('File not found on disk');

    const stat = fs.statSync(media.file_path);
    const etag = `"${stat.ino}-${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    res.setHeader('Content-Type', media.mime_type || 'image/jpeg');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(media.file_path, { highWaterMark: 256 * 1024 }).pipe(res);
  } catch(e) { res.status(500).send('Server error'); }
});

/**
 * Serve a thumbnail — auto-generates on first request if missing.
 * GET /thumb/:id
 */
router.get('/thumb/:id', async (req, res) => {
  try {
    const mediaId = Number(req.params.id);
    const [rows] = await pool.query('SELECT id, thumb_path, type, file_path, mime_type FROM media WHERE id = ?', [mediaId]);
    if (!rows.length) return res.status(404).send('Not found');
    const media = rows[0];

    const serveThumb = (thumbPath) => {
      const stat = fs.statSync(thumbPath);
      const etag = `"t-${stat.ino}-${stat.size}"`;
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); // 7d
      fs.createReadStream(thumbPath, { highWaterMark: 128 * 1024 }).pipe(res);
    };

    // Already have a stored thumb
    if (media.thumb_path && fs.existsSync(media.thumb_path)) {
      return serveThumb(media.thumb_path);
    }

    // Auto-generate thumb on first request
    let thumbPath = null;
    if (media.type === 'photo' && fs.existsSync(media.file_path)) {
      thumbPath = await generatePhotoThumb(media.file_path, media.id);
    } else if (media.type === 'video' && fs.existsSync(media.file_path)) {
      thumbPath = await generateVideoThumb(media.file_path, media.id);
    }

    if (thumbPath && fs.existsSync(thumbPath)) {
      // Save to DB (fire-and-forget)
      updateThumb(media.id, thumbPath).catch(() => {});
      return serveThumb(thumbPath);
    }

    // Fallback: serve photo original or placeholder
    if (media.type === 'photo' && fs.existsSync(media.file_path)) {
      res.setHeader('Content-Type', media.mime_type || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return fs.createReadStream(media.file_path, { highWaterMark: 128 * 1024 }).pipe(res);
    }

    // No thumb available — return 404 so the frontend onerror handler can react
    res.status(404).send('Thumbnail not available');
  } catch(e) { res.status(500).send('Server error'); }
});

module.exports = router;
