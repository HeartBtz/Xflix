const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { create: contentDisposition } = require('content-disposition');
const { pool, updateThumb } = require('../db');
const { generateVideoThumb, generatePhotoThumb, MEDIA_DIR, THUMB_DIR } = require('../scanner');
const { requireContentAuth, REQUIRE_CONTENT_AUTH } = require('../middleware/auth');
const { parseByteRange } = require('../lib/security');
const { resolveInside } = require('../lib/media-files');

const CACHE_SCOPE = REQUIRE_CONTENT_AUTH ? 'private' : 'public';
const MAX_CONCURRENT_THUMBS = 3;
let activeThumbs = 0;
const thumbQueue = [];
const thumbInProgress = new Map();

function fail(res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy(error);
  for (const header of ['Content-Length', 'Content-Range', 'Content-Type', 'Content-Disposition', 'ETag', 'Last-Modified']) res.removeHeader(header);
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : error.code === 'EACCES' || error.code === 'ELOOP' ? 403 : 500)
    .send('File unavailable');
}

async function serveFile(req, res, root, target, mime, { ranges = false, download = false } = {}) {
  const resolved = await resolveInside(root, target);
  const handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let transferred = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error('Not a regular file'), { code: 'ENOENT' });
    if (res.destroyed) return;
    const etag = `"${stat.ino}-${stat.size}-${stat.mtimeMs}"`;
    const modified = Math.floor(stat.mtimeMs / 1000) * 1000;
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', new Date(modified).toUTCString());
    res.setHeader('Cache-Control', download ? 'private, no-store' : `${CACHE_SCOPE}, max-age=3600`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (download) res.setHeader('Content-Disposition', contentDisposition(path.basename(target), { type: 'attachment' }));
    if (ranges) res.setHeader('Accept-Ranges', 'bytes');
    const noneMatch = req.headers['if-none-match'];
    if (noneMatch && noneMatch.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)) {
      res.status(304).end();
      return;
    }
    let range = ranges ? req.headers.range : null;
    const ifRange = req.headers['if-range'];
    if (range && ifRange && ifRange !== etag) {
      const date = Date.parse(ifRange);
      if (!Number.isFinite(date) || new Date(date).toUTCString() !== ifRange || date < modified) range = null;
    }
    let options = { highWaterMark: 256 * 1024 };
    if (range) {
      const parsed = parseByteRange(range, stat.size);
      if (!parsed) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.status(416).end();
        return;
      }
      options = { ...options, ...parsed };
      res.status(206);
      res.setHeader('Content-Range', `bytes ${parsed.start}-${parsed.end}/${stat.size}`);
      res.setHeader('Content-Length', parsed.end - parsed.start + 1);
    } else res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = handle.createReadStream(options);
    transferred = true;
    const disconnect = () => stream.destroy();
    res.once('close', disconnect);
    stream.once('close', () => res.off('close', disconnect));
    stream.once('error', error => fail(res, error));
    stream.pipe(res);
  } finally {
    if (!transferred) await handle.close();
  }
}

router.get('/stream/:id', requireContentAuth, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM media WHERE id = ? AND type = 'video'", [Number(req.params.id)]);
    if (!rows.length) return res.status(404).send('Not found');
    await serveFile(req, res, MEDIA_DIR, rows[0].file_path, rows[0].mime_type || 'video/mp4', { ranges: true });
  } catch (error) { fail(res, error); }
});

router.get('/photo/:id', requireContentAuth, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT file_path, mime_type FROM media WHERE id = ? AND type = 'photo'", [Number(req.params.id)]);
    if (!rows.length) return res.status(404).send('Not found');
    await serveFile(req, res, MEDIA_DIR, rows[0].file_path, rows[0].mime_type || 'image/jpeg');
  } catch (error) { fail(res, error); }
});

router.get('/thumb/:id', requireContentAuth, async (req, res) => {
  try {
    const mediaId = Number(req.params.id);
    const [rows] = await pool.query('SELECT id, thumb_path, type, file_path, mime_type FROM media WHERE id = ?', [mediaId]);
    if (!rows.length) return res.status(404).send('Not found');
    const media = rows[0];
    if (media.thumb_path) {
      try {
        await serveFile(req, res, THUMB_DIR, media.thumb_path, 'image/jpeg');
        return;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (res.destroyed) return;
    // Validate before queueing work, including the original-photo fallback.
    const source = await resolveInside(MEDIA_DIR, media.file_path);
    let work = thumbInProgress.get(mediaId);
    if (!work) {
      if (thumbQueue.length >= MAX_CONCURRENT_THUMBS) return res.status(503).set('Retry-After', '4').send('Busy');
      work = (async () => {
        if (activeThumbs >= MAX_CONCURRENT_THUMBS) await new Promise(resolve => thumbQueue.push(resolve));
        else activeThumbs++;
        try {
          const generated = media.type === 'photo'
            ? await generatePhotoThumb(source, media.id)
            : await generateVideoThumb(source, media.id);
          if (generated) await updateThumb(media.id, generated);
          return generated;
        } finally {
          thumbInProgress.delete(mediaId);
          const next = thumbQueue.shift();
          if (next) next(); else activeThumbs--;
        }
      })();
      thumbInProgress.set(mediaId, work);
    }
    const thumbnail = await work;
    if (res.destroyed) return;
    if (thumbnail) return await serveFile(req, res, THUMB_DIR, thumbnail, 'image/jpeg');
    if (media.type === 'photo') return await serveFile(req, res, MEDIA_DIR, source, media.mime_type || 'image/jpeg');
    res.status(404).send('Thumbnail not available');
  } catch (error) { fail(res, error); }
});

router.get('/download/:id', requireContentAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM media WHERE id = ?', [Number(req.params.id)]);
    if (!rows.length) return res.status(404).send('Not found');
    await serveFile(req, res, MEDIA_DIR, rows[0].file_path, rows[0].mime_type, { download: true });
  } catch (error) { fail(res, error); }
});

module.exports = router;
