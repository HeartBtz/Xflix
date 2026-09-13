'use strict';

const express = require('express');
const router = express.Router();
const path = require('node:path');
const fs = require('node:fs');
const { pool, updateUserRole, deleteUser } = require('../db');
const { requireAdmin, requireSameOrigin } = require('../middleware/auth');
const { testSmtp } = require('../services/mail');
const { boundedInteger } = require('../lib/security');
const { withMaintenance } = require('../lib/maintenance');
const { resolveInside } = require('../lib/media-files');
const { MAX_IDS, fail, idsInput, booleanInput, mediaPath, storageReady, isMissing,
  hashFile, removeMedia, quarantineThumb } = require('../lib/admin-media');
const scanner = require('../scanner');
const { MEDIA_DIR, THUMB_DIR, VIDEO_EXTS, PHOTO_EXTS } = scanner;

router.use(requireSameOrigin, requireAdmin);

function errorData(error) {
  return { status: 'error', error: error.status ? error.message : 'Maintenance failed',
    code: error.status || 500, deleted: error.deleted ?? (error.recovery_required ? null : 0),
    operation_id: error.operation_id, recovery_required: error.recovery_required || false,
    compensation_errors: error.compensation_errors };
}

function httpError(res, error) {
  res.status([400, 403, 404, 409, 503].includes(error.status) ? error.status : 500).json(errorData(error));
}

function routeId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw fail('Invalid id');
  return idsInput([Number(value)])[0];
}

// Acquire before attaching cancellation handlers. A rejected second request
// must never cancel the first job when its own response closes.
async function streamJob(req, res, operation, onCancel = () => {}) {
  let closed = false;
  let finished = false;
  const close = () => {
    closed = true;
    if (!finished) onCancel();
  };
  try {
    await withMaintenance(async () => {
      if (res.destroyed) return;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      res.on('close', close);
      const send = data => {
        if (!closed) {
          try { res.write(`data: ${JSON.stringify(data)}\n\n`); if (res.flush) res.flush(); }
          catch (_) { close(); }
        }
      };
      const heartbeat = setInterval(() => {
        if (!closed) { try { res.write(': keep-alive\n\n'); } catch (_) { close(); } }
      }, 10000);
      try { await operation(send, () => closed); }
      catch (error) { send(errorData(error)); }
      finally {
        finished = true;
        clearInterval(heartbeat);
        if (!closed) res.end();
        res.removeListener('close', close);
      }
    });
  } catch (error) {
    if (!res.headersSent) httpError(res, error);
    else if (!res.writableEnded && !res.destroyed) res.end();
  }
}

router.get('/stats', async (req, res) => {
  try {
    const counts = await Promise.all(['users', 'media', 'comments', 'media_reactions']
      .map(table => pool.query(`SELECT COUNT(*) as cnt FROM ${table}`)));
    res.json(Object.fromEntries(['users', 'media', 'comments', 'reactions'].map((key, i) => [key, counts[i][0][0].cnt])));
  } catch (error) { httpError(res, error); }
});

router.get('/users', async (req, res) => {
  try {
    const page = boundedInteger(req.query.page, 1, 1, 1_000_000);
    const limit = boundedInteger(req.query.limit, 50, 1, 200);
    const raw = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : '';
    const params = raw ? Array(2).fill(`%${raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`) : [];
    const where = raw ? ' WHERE username LIKE ? OR email LIKE ?' : '';
    const [[{ total }]] = await pool.query('SELECT COUNT(*) as total FROM users' + where, params);
    const [data] = await pool.query('SELECT id, username, email, role, avatar, bio, last_login, created_at FROM users' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?', [...params, limit, (page - 1) * limit]);
    res.json({ data, total, page, limit });
  } catch (error) { httpError(res, error); }
});

router.patch('/users/:id/role', async (req, res) => {
  try {
    const id = routeId(req.params.id);
    const { role } = req.body || {};
    if (!['admin', 'member'].includes(role)) throw fail('Invalid role');
    await updateUserRole(id, role, req.user.id);
    res.json({ id, role });
  } catch (error) { httpError(res, error); }
});

router.delete('/users/:id', async (req, res) => {
  try {
    await deleteUser(routeId(req.params.id), req.user.id);
    res.json({ message: 'User deleted' });
  } catch (error) { httpError(res, error); }
});

router.get('/settings', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT `key`, value FROM settings');
    const settings = Object.fromEntries(rows.map(row => [row.key, row.value]));
    if (settings.smtp_pass) settings.smtp_pass = '\u2022'.repeat(8);
    res.json(settings);
  } catch (error) { httpError(res, error); }
});

router.put('/settings', async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Settings must be an object');
    const allowed = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure', 'allow_registration'];
    const updates = {};
    for (const [key, value] of Object.entries(body)) {
      if (!allowed.includes(key)) throw fail('Unknown setting');
      if (key === 'smtp_secure' || key === 'allow_registration') {
        if (![true, false, 'true', 'false'].includes(value)) throw fail(`${key} must be a boolean or boolean string`);
        updates[key] = String(value);
      } else if (key === 'smtp_port') {
        if (!((typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^\d{1,5}$/.test(value))) || Number(value) < 1 || Number(value) > 65535) throw fail('Invalid SMTP port');
        updates[key] = String(Number(value));
      } else {
        if (typeof value !== 'string' || value.length > (key === 'smtp_pass' ? 4096 : 500) || /[\r\n\0]/.test(value)) throw fail(`Invalid ${key}`);
        if (key === 'smtp_host' && value && !/^[a-zA-Z0-9.:[\]-]+$/.test(value)) throw fail('Invalid SMTP host');
        updates[key] = value;
      }
    }
    await withMaintenance(async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [rows] = await conn.query('SELECT `key`, value FROM settings FOR UPDATE');
        const old = Object.fromEntries(rows.map(row => [row.key, row.value]));
        const changed = ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user'].some(key => key in updates && updates[key] !== old[key]);
        const suppliedSecret = typeof updates.smtp_pass === 'string' && updates.smtp_pass !== '' && updates.smtp_pass !== '\u2022'.repeat(8);
        if (!suppliedSecret) {
          delete updates.smtp_pass;
          if (changed) updates.smtp_pass = '';
        }
        for (const [key, value] of Object.entries(updates)) {
          await conn.query('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()', [key, value, value]);
        }
        await conn.commit();
      } catch (error) { await conn.rollback(); throw error; }
      finally { conn.release(); }
    });
    res.json({ message: 'Settings saved' });
  } catch (error) { httpError(res, error); }
});

router.post('/settings/test-smtp', async (req, res) => {
  try { res.json({ ok: true, message: 'SMTP connection successful', info: await withMaintenance(() => testSmtp()) }); }
  catch (error) { res.status(error.status || 500).json({ ok: false, error: 'SMTP connection failed' }); }
});

let scanJob = null;
let thumbJob = null;
router.post('/scan/cancel', (req, res) => {
  if (scanJob) { scanJob.cancelled = true; scanner.cancelScan(); }
  res.json({ message: 'Cancel requested', running: Boolean(scanJob) });
});

router.post('/scan', async (req, res) => {
  const { mode = 'all' } = req.body || {};
  if (!['all', 'photos', 'videos'].includes(mode)) return httpError(res, fail('Invalid mode'));
  if (scanJob || scanner.getProgress().running) return httpError(res, fail('Scan already running', 409));
  const job = { cancelled: false };
  scanJob = job;
  try {
    await streamJob(req, res, async send => {
      await storageReady();
      if (job.cancelled) throw fail('Scan cancelled', 409);
      send({ status: 'started' });
      await scanner.runScan(mode, progress => send({ ...progress, status: 'progress' }), () => job.cancelled);
      const progress = scanner.getProgress();
      send({ ...progress, status: job.cancelled || progress.cancelled || progress.errors ? 'error' : 'done',
        cancelled: job.cancelled || progress.cancelled, error: job.cancelled || progress.cancelled ? 'Scan cancelled' : progress.errors ? 'Scan completed with errors' : undefined });
    }, () => { job.cancelled = true; scanner.cancelScan(); });
  } finally { if (scanJob === job) scanJob = null; }
});

router.post('/batch-thumbs/cancel', (req, res) => {
  if (thumbJob) thumbJob.cancelled = true;
  res.json({ message: 'Cancel requested', running: Boolean(thumbJob) });
});

router.post('/batch-thumbs', async (req, res) => {
  if (thumbJob) return httpError(res, fail('Thumbnail job already running', 409));
  const job = { cancelled: false };
  thumbJob = job;
  try {
    await streamJob(req, res, async (send, closed) => {
      await storageReady();
      const [rows] = await pool.query('SELECT id, file_path, type FROM media');
      const queue = [];
      for (const row of rows) {
        if (job.cancelled || closed()) break;
        const target = await resolveInside(THUMB_DIR, path.join(THUMB_DIR, `${row.type === 'video' ? 'v' : 'p'}_${row.id}.jpg`), { allowMissing: true });
        try { await fs.promises.stat(target); }
        catch (error) { if (error.code !== 'ENOENT') throw error; queue.push(row); }
      }
      const total = queue.length;
      let done = 0;
      const errors = [];
      send({ total, done });
      const workers = Array.from({ length: 3 }, async () => {
        while (queue.length && !job.cancelled && !closed()) {
          const row = queue.shift();
          try {
            const source = await mediaPath(row.file_path);
            if (job.cancelled || closed()) break;
            const result = row.type === 'video' ? await scanner.generateVideoThumb(source, row.id) : await scanner.generatePhotoThumb(source, row.id);
            if (!result) throw fail('Thumbnail generation failed', 500);
            done++;
          } catch (_) { errors.push({ id: row.id, error: 'Thumbnail generation failed' }); }
          send({ total, done, errors: errors.length });
        }
      });
      // Drain already-started scanner children before releasing the maintenance lock.
      const results = await Promise.allSettled(workers);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      const cancelled = job.cancelled || closed();
      send({ status: cancelled || errors.length ? 'error' : 'done', total, done, cancelled, errors,
        error: cancelled ? 'Thumbnail job cancelled' : errors.length ? 'Some thumbnails failed' : undefined });
    }, () => { job.cancelled = true; });
  } finally { if (thumbJob === job) thumbJob = null; }
});

router.get('/media', async (req, res) => {
  try {
    const { performer_id, type, q: rawQ = '' } = req.query;
    const q = typeof rawQ === 'string' ? rawQ.slice(0, 200) : '';
    const page = boundedInteger(req.query.page, 1, 1, 1_000_000);
    const limit = boundedInteger(req.query.limit, 60, 1, 200);
    const where = ['1=1'];
    const params = [];
    if (performer_id) { where.push('m.performer_id = ?'); params.push(routeId(performer_id)); }
    if (type && ['video', 'photo'].includes(type)) { where.push('m.type = ?'); params.push(type); }
    if (q) { where.push('m.file_path LIKE ?'); params.push(`%${q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`); }
    const whereStr = where.join(' AND ');
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM media m WHERE ${whereStr}`, params);
    const [data] = await pool.query(`SELECT m.id, m.file_path, m.type, m.size, p.name AS performer_name
      FROM media m JOIN performers p ON p.id = m.performer_id WHERE ${whereStr} ORDER BY m.file_path LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    res.json({ data, total, page, limit });
  } catch (error) { httpError(res, error); }
});

router.post('/duplicates/scan', async (req, res) => {
  const { mediaType = 'all' } = req.body || {};
  if (!['all', 'video', 'photo'].includes(mediaType)) return httpError(res, fail('Invalid mediaType'));
  await streamJob(req, res, async (send, closed) => {
    await storageReady();
    send({ status: 'phase', phase: 'loading' });
    const [rows] = await pool.query(`SELECT m.id, m.file_path, m.size, m.type, m.performer_id, p.name AS performer_name
      FROM media m JOIN performers p ON p.id = m.performer_id${mediaType === 'all' ? '' : ' WHERE m.type = ?'}`, mediaType === 'all' ? [] : [mediaType]);
    const bySize = new Map();
    for (const row of rows) {
      if (closed()) return;
      const st = await fs.promises.stat(await mediaPath(row.file_path));
      if (!st.isFile()) throw fail('Not a regular media file', 409);
      const key = `${row.type}:${st.size}`;
      if (!bySize.has(key)) bySize.set(key, []);
      bySize.get(key).push({ ...row, size: st.size });
    }
    const candidates = [...bySize.values()].filter(group => group.length > 1);
    const groups = [];
    let done = 0;
    send({ status: 'phase', phase: 'hashing', total: candidates.length, done });
    for (const group of candidates) {
      const byHash = new Map();
      // One open hashing descriptor at a time, regardless of group size.
      for (const row of group) {
        const result = await hashFile(row.file_path, { cancelled: closed });
        if (!byHash.has(result.hash)) byHash.set(result.hash, []);
        byHash.get(result.hash).push(row);
      }
      groups.push(...[...byHash.values()].filter(items => items.length > 1));
      send({ status: 'progress', phase: 'hashing', done: ++done, total: candidates.length });
    }
    send({ status: 'done', groups, count: groups.reduce((count, group) => count + group.length, 0) });
  });
});

router.post('/duplicates/delete-bulk', async (req, res) => {
  try {
    const ids = idsInput(req.body?.ids);
    const deleteFile = booleanInput(req.body, 'deleteFile');
    const dry_run = booleanInput(req.body, 'dry_run', false);
    await streamJob(req, res, async (send, closed) => {
      send({ status: 'started', total: ids.length });
      if (dry_run) { send({ status: 'done', dry_run, deleted: 0, errors: [] }); return; }
      const result = await removeMedia({ ids, deleteFile, duplicate: true, actorId: req.user.id, cancelled: closed,
        progress: progress => send({ status: 'progress', ...progress, skipped: true }) });
      // Older clients remove cards on progress unless skipped. Publish those
      // confirmations only after the entire SQL transaction has committed.
      ids.forEach((id, index) => send({ status: 'progress', id, done: index + 1, total: ids.length, staged: false, skipped: false }));
      send({ status: 'done', ...result, errors: [] });
    });
  } catch (error) { httpError(res, error); }
});

for (const endpoint of ['/duplicates/:id', '/media/:id']) {
  router.delete(endpoint, async (req, res) => {
    try {
      const id = routeId(req.params.id);
      const deleteFile = booleanInput(req.body, 'deleteFile');
      const dry_run = booleanInput(req.body, 'dry_run', false);
      if (req.query.delete_file !== undefined) throw fail('Use the JSON deleteFile boolean, not delete_file');
      if (dry_run) return res.json({ message: 'Dry run; no changes', id, dry_run, deleted: 0 });
      const result = await removeMedia({ ids: [id], deleteFile, duplicate: endpoint.startsWith('/duplicates'), actorId: req.user.id });
      res.json({ message: 'Deleted', id, ...result });
    } catch (error) { httpError(res, error); }
  });
}

router.post('/clean-media', async (req, res) => {
  try {
    const dry_run = booleanInput(req.body, 'dry_run', true);
    const verbose = booleanInput(req.body, 'verbose', false);
    await streamJob(req, res, async (send, closed) => {
      await storageReady();
      const [rows] = await pool.query('SELECT id, file_path, type FROM media ORDER BY id');
      const dbPaths = new Set();
      const orphaned = [];
      const thumbs = [];
      let unindexed = 0;
      let diskScanned = 0;
      send({ status: 'started', dry_run });
      for (const row of rows) {
        if (closed()) return;
        dbPaths.add(await mediaPath(row.file_path, true));
        if (await isMissing(row.file_path)) orphaned.push(row.id);
      }
      send({ status: 'phase_done', phase: 1, found: orphaned.length, done: rows.length, total: rows.length });
      async function walk(dir) {
        const canonical = await mediaPath(dir);
        for (const entry of await fs.promises.readdir(canonical, { withFileTypes: true })) {
          if (closed()) return;
          if (entry.name === '.xflix-trash' || entry.isSymbolicLink()) continue;
          const full = path.join(canonical, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile() && (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase()) || PHOTO_EXTS.has(path.extname(entry.name).toLowerCase()))) {
            diskScanned++;
            if (!dbPaths.has(full)) { unindexed++; if (verbose) send({ status: 'progress', phase: 2, type: 'unindexed', line: full }); }
          }
        }
      }
      await walk(MEDIA_DIR);
      send({ status: 'phase_done', phase: 2, found: unindexed, done: diskScanned, total: diskScanned });
      const dbIds = new Set(rows.map(row => Number(row.id)));
      for (const file of await fs.promises.readdir(await fs.promises.realpath(THUMB_DIR))) {
        if (file === '.xflix-trash') continue;
        const match = file.match(/^[vp]_(\d+)\.(jpg|png|webp)$/);
        if (match && !dbIds.has(Number(match[1]))) thumbs.push({ id: Number(match[1]), path: path.join(THUMB_DIR, file) });
      }
      send({ status: 'phase_done', phase: 3, found: thumbs.length, done: thumbs.length, total: thumbs.length });
      let deletedDb = 0;
      let deletedThumbs = 0;
      let operationId;
      try {
        if (!dry_run) {
          if (orphaned.length + thumbs.length > MAX_IDS) throw fail('Cleanup exceeds the 500 item limit');
          // No writes until the complete inventory has succeeded, including thumbnail storage.
          if (orphaned.length) await storageReady({ missing: true });
          if (closed()) return;
          if (orphaned.length) {
            const result = await removeMedia({ ids: orphaned, deleteFile: false, missing: true, actorId: req.user.id, cancelled: closed });
            deletedDb = result.deleted;
            operationId = result.operation_id;
          }
          for (const thumb of thumbs) {
            if (closed()) throw fail('Cleanup cancelled', 409);
            const [[live]] = await pool.query('SELECT id FROM media WHERE id = ?', [thumb.id]);
            if (live) throw fail('Thumbnail is no longer orphaned', 409);
            await quarantineThumb(thumb.path);
            deletedThumbs++;
          }
        }
        send({ status: 'done', dry_run, orphaned_db: orphaned.length, unindexed_files: unindexed,
          orphaned_thumbs: thumbs.length, deleted_db: deletedDb, deleted_thumbs: deletedThumbs, operation_id: operationId });
      } catch (error) {
        const dbCount = 'deleted' in error ? error.deleted : deletedDb;
        const thumbCount = error.quarantined === null ? null : deletedThumbs + (error.quarantined || 0);
        send({ ...errorData(error), dry_run, deleted: dbCount, deleted_db: dbCount, deleted_thumbs: thumbCount,
          partial: dbCount > 0 || thumbCount > 0 || error.recovery_required === true,
          operation_id: error.operation_id || operationId });
      }
    });
  } catch (error) { httpError(res, error); }
});

router.post('/purge-short-videos', async (req, res) => {
  try {
    const dry_run = booleanInput(req.body, 'dry_run', true);
    const maxSec = req.body?.max_duration === undefined ? 120 : req.body.max_duration;
    if (typeof maxSec !== 'number' || !Number.isFinite(maxSec) || maxSec < 1 || maxSec > 86400) throw fail('max_duration must be a number between 1 and 86400 seconds');
    await streamJob(req, res, async (send, closed) => {
      await storageReady();
      const [rows] = await pool.query("SELECT id, file_path, duration FROM media WHERE type = 'video' AND duration > 0 AND duration < ? ORDER BY duration ASC LIMIT 501", [maxSec]);
      if (rows.length > MAX_IDS) throw fail('Purge exceeds the 500 media limit; reduce max_duration');
      send({ status: 'found', count: rows.length, dry_run });
      for (const row of rows) send({ status: 'preview', id: row.id, line: path.basename(row.file_path) });
      let result = { deleted: 0 };
      if (!dry_run && rows.length) {
        send({ status: 'started', total: rows.length });
        result = await removeMedia({ ids: rows.map(row => row.id), deleteFile: true, maxDuration: maxSec,
          actorId: req.user.id, cancelled: closed, progress: progress => send({ status: 'progress', ...progress }) });
      }
      send({ status: 'done', dry_run, total: rows.length, errors: 0, ...result });
    });
  } catch (error) { httpError(res, error); }
});

module.exports = router;
