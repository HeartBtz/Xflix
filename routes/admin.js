const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const { pool, getSetting, setSetting, listUsers, updateUserRole, deleteUser, countAdmins } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { testSmtp } = require('../services/mail');
const scanner  = require('../scanner');
const { MEDIA_DIR, THUMB_DIR, VIDEO_EXTS, PHOTO_EXTS } = scanner;

// All admin routes require auth + admin role
router.use(requireAuth, requireAdmin);

/* ══════════════════════════════════════════════════════════════════
   DASHBOARD STATS
   ══════════════════════════════════════════════════════════════════ */
router.get('/stats', async (req, res) => {
  try {
    const [r1, r2, r3, r4] = await Promise.all([
      pool.query('SELECT COUNT(*) as cnt FROM users'),
      pool.query('SELECT COUNT(*) as cnt FROM media'),
      pool.query('SELECT COUNT(*) as cnt FROM comments'),
      pool.query('SELECT COUNT(*) as cnt FROM media_reactions'),
    ]);
    res.json({
      users:     r1[0][0].cnt,
      media:     r2[0][0].cnt,
      comments:  r3[0][0].cnt,
      reactions: r4[0][0].cnt,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════
   USER MANAGEMENT
   ══════════════════════════════════════════════════════════════════ */
router.get('/users', async (req, res) => {
  try {
    const page   = Number(req.query.page) || 1;
    const limit  = Math.min(Number(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const search = req.query.search ? `%${req.query.search}%` : null;

    let q = 'SELECT id, username, email, role, avatar, bio, last_login, created_at FROM users';
    const params = [];
    if (search) { q += ' WHERE username LIKE ? OR email LIKE ?'; params.push(search, search); }
    const [[{ total }]] = await pool.query('SELECT COUNT(*) as total FROM users' + (search ? ' WHERE username LIKE ? OR email LIKE ?' : ''), params);
    const [rows] = await pool.query(`${q} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    res.json({ data: rows, total, page, limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/users/:id/role', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { role } = req.body || {};
    if (!['admin','member'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'Cannot demote yourself' });
    if (role !== 'admin') {
      const [[{ admins }]] = await pool.query("SELECT COUNT(*) as admins FROM users WHERE role='admin' AND id != ?", [id]);
      if (admins === 0) return res.status(400).json({ error: 'Must have at least one admin' });
    }
    await updateUserRole(id, role);
    res.json({ id, role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/users/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    const n = await countAdmins();
    const [[target]] = await pool.query("SELECT role FROM users WHERE id=?", [id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin' && n <= 1) return res.status(400).json({ error: 'Last admin cannot be deleted' });
    await deleteUser(id);
    res.json({ message: 'User deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════
   SETTINGS (SMTP + registration)
   ══════════════════════════════════════════════════════════════════ */
router.get('/settings', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT `key`, value FROM settings');
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });
    // Never expose raw password — mask it
    if (s.smtp_pass) s.smtp_pass = '••••••••';
    res.json(s);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', async (req, res) => {
  try {
    const allowed = ['smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from','smtp_secure','allow_registration'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        let val = String(req.body[key]);
        // Don't overwrite pw if masked placeholder sent
        if (key === 'smtp_pass' && val === '••••••••') continue;
        await setSetting(key, val);
      }
    }
    res.json({ message: 'Settings saved' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/settings/test-smtp', async (req, res) => {
  try {
    const result = await testSmtp();
    res.json({ ok: true, message: 'SMTP connection successful', info: result });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════════
   SCAN
   ══════════════════════════════════════════════════════════════════ */
// Cancel an in-progress scan
router.post('/scan/cancel', (req, res) => {
  scanner.cancelScan();
  res.json({ message: 'Cancel requested' });
});

router.post('/scan', async (req, res) => {
  const { mode = 'all' } = req.body || {};
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let closed = false;
  const send = (data) => { if (!closed) try { res.write(`data: ${JSON.stringify(data)}\n\n`); if (res.flush) res.flush(); } catch(_) {} };

  res.on('close', () => {
    if (!closed) {
      closed = true;
      scanner.cancelScan();
    }
  });

  try {
    send({ status: 'started' });

    // Pass onProgress callback directly — fires after each batch insert
    const scanPromise = scanner.scanDirectory(mode, (progress) => {
      send({ status: 'progress', ...progress });
    });

    await scanPromise;

    if (!closed) {
      const p = scanner.getProgress();
      send({ status: 'done', ...p });
      res.end();
    }
  } catch(e) {
    send({ status: 'error', error: e.message });
    if (!closed) res.end();
  }
});

/* ══════════════════════════════════════════════════════════════════
   BATCH THUMBNAIL GENERATION
   ══════════════════════════════════════════════════════════════════ */
router.post('/batch-thumbs/cancel', (req, res) => {
  // Signal handled by closed flag on the SSE request; just acknowledge
  res.json({ message: 'Cancel requested' });
});

router.post('/batch-thumbs', async (req, res) => {
  try {
    const { generateVideoThumb, generatePhotoThumb } = scanner;

    const [allMedia] = await pool.query('SELECT id, file_path, type FROM media');
    // Thumb files are named v_<id>.jpg for videos, p_<id>.jpg for photos
    const missing = allMedia.filter(m => {
      const name = m.type === 'video' ? `v_${m.id}.jpg` : `p_${m.id}.jpg`;
      return !fs.existsSync(path.join(THUMB_DIR, name));
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let closed = false;
    res.on('close', () => { closed = true; });
    const send = d => { if (!closed) try { res.write(`data: ${JSON.stringify(d)}\n\n`); if (res.flush) res.flush(); } catch(_) {} };

    send({ total: missing.length, done: 0 });
    if (!missing.length) { send({ status: 'done', total: 0, done: 0 }); res.end(); return; }

    let done = 0;
    const concurrency = 3;
    const queue = [...missing];

    const worker = async () => {
      while (queue.length && !closed) {
        const item = queue.shift();
        if (!item) break;
        try {
          if (item.type === 'video') await generateVideoThumb(item.file_path, item.id);
          else await generatePhotoThumb(item.file_path, item.id);
        } catch(_) {}
        done++;
        if (done % 5 === 0 || queue.length === 0) send({ total: missing.length, done });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (!closed) { send({ status: 'done', total: missing.length, done }); res.end(); }
  } catch(e) {
    try { res.write(`data: ${JSON.stringify({ status: 'error', error: e.message })}\n\n`); res.end(); } catch(_) {}
  }
});

/* ══════════════════════════════════════════════════════════════════
   MEDIA BROWSER
   ══════════════════════════════════════════════════════════════════ */
// GET /admin/media?performer_id=&type=&q=&page=1&limit=60
router.get('/media', async (req, res) => {
  try {
    const { performer_id, type, q = '', page = 1, limit = 60 } = req.query;
    const off = (Number(page) - 1) * Number(limit);
    let where = ['1=1'];
    const params = [];
    if (performer_id) { where.push('m.performer_id = ?'); params.push(Number(performer_id)); }
    if (type && ['video','photo'].includes(type)) { where.push('m.type = ?'); params.push(type); }
    if (q) { where.push('m.file_path LIKE ?'); params.push(`%${q}%`); }
    const whereStr = where.join(' AND ');
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM media m WHERE ${whereStr}`, params);
    const [rows] = await pool.query(
      `SELECT m.id, m.file_path, m.type, m.size, p.name AS performer_name
       FROM media m JOIN performers p ON p.id = m.performer_id
       WHERE ${whereStr} ORDER BY m.file_path LIMIT ? OFFSET ?`,
      [...params, Number(limit), off]);
    res.json({ data: rows, total, page: Number(page), limit: Number(limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════
   DUPLICATE DETECTION
   ══════════════════════════════════════════════════════════════════ */
// SSE — POST /admin/duplicates/scan  (streams progress)
router.post('/duplicates/scan', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let closed = false;
  const send = (data) => {
    if (!closed) try { res.write(`data: ${JSON.stringify(data)}\n\n`); if (res.flush) res.flush(); } catch(_) {}
  };
  res.on('close', () => { closed = true; });

  try {
    const { mediaType = 'all' } = req.body || {}; // 'all' | 'video' | 'photo'
    const typeFilter = (mediaType === 'video' || mediaType === 'photo') ? mediaType : null;
    const typeLabel  = typeFilter === 'video' ? 'vidéos' : typeFilter === 'photo' ? 'photos' : 'médias';

    // Phase 1: load media (filtered by type if requested)
    send({ status: 'phase', phase: 'loading', message: `Chargement des ${typeLabel}…` });
    const [rows] = await pool.query(
      typeFilter
        ? `SELECT m.id, m.file_path, m.size, m.type, m.performer_id, p.name as performer_name
           FROM media m JOIN performers p ON p.id = m.performer_id WHERE m.type = ?`
        : `SELECT m.id, m.file_path, m.size, m.type, m.performer_id, p.name as performer_name
           FROM media m JOIN performers p ON p.id = m.performer_id`,
      typeFilter ? [typeFilter] : []
    );
    if (closed) return;

    // Phase 2: stat files that have no size in DB (async, non-blocking)
    send({ status: 'phase', phase: 'sizing', message: `Vérification des tailles (${rows.length} fichiers)…`, total: rows.length });
    const withSize = await Promise.all(rows.map(async r => {
      if (r.size) return r;
      try { const st = await fs.promises.stat(r.file_path); return { ...r, size: st.size }; }
      catch { return { ...r, size: 0 }; }
    }));
    if (closed) return;

    // Group by identical size — only groups with ≥2 files are candidates
    const bySizeMap = {};
    for (const m of withSize) {
      if (!m.size) continue;
      if (!bySizeMap[m.size]) bySizeMap[m.size] = [];
      bySizeMap[m.size].push(m);
    }
    const candidates = Object.values(bySizeMap).filter(g => g.length > 1);
    const totalCandidateFiles = candidates.reduce((a, g) => a + g.length, 0);

    if (candidates.length === 0) {
      send({ status: 'done', groups: [], count: 0 });
      if (!closed) res.end();
      return;
    }

    send({ status: 'phase', phase: 'hashing',
      message: `Hash de ${candidates.length} groupe(s) — ${totalCandidateFiles} fichiers suspects…`,
      total: candidates.length, done: 0 });

    // Phase 3: async hash of first 64 KB of each candidate (non-blocking fd)
    const hashFile = async (fpath) => {
      try {
        const fh = await fs.promises.open(fpath, 'r');
        const buf = Buffer.alloc(65536);
        const { bytesRead } = await fh.read(buf, 0, 65536, 0);
        await fh.close();
        return crypto.createHash('md5').update(buf.slice(0, bytesRead)).digest('hex');
      } catch { return null; }
    };

    const groups = [];
    let done = 0;
    for (const group of candidates) {
      if (closed) return;
      const hashes = await Promise.all(group.map(m => hashFile(m.file_path)));
      const byHash = {};
      group.forEach((m, i) => {
        if (!hashes[i]) return;
        if (!byHash[hashes[i]]) byHash[hashes[i]] = [];
        byHash[hashes[i]].push(m);
      });
      for (const dups of Object.values(byHash)) {
        if (dups.length > 1) groups.push(dups);
      }
      done++;
      send({ status: 'progress', phase: 'hashing', done, total: candidates.length });
    }

    if (!closed) {
      send({ status: 'done', groups, count: groups.reduce((a, g) => a + g.length, 0) });
      res.end();
    }
  } catch(e) { send({ status: 'error', error: e.message }); if (!closed) res.end(); }
});

// POST /admin/duplicates/delete-bulk — SSE stream — bulk delete with live progress
router.post('/duplicates/delete-bulk', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let closed = false;
  res.on('close', () => { closed = true; });
  const send = (data) => {
    if (!closed) try { res.write(`data: ${JSON.stringify(data)}\n\n`); if (res.flush) res.flush(); } catch(_) {}
  };

  try {
    const { ids = [], deleteFile = true } = req.body || {};
    if (!ids.length) { send({ status: 'done', deleted: 0, errors: [] }); if (!closed) res.end(); return; }

    send({ status: 'started', total: ids.length });
    let deleted = 0;
    const errors = [];

    for (const id of ids) {
      if (closed) break;
      try {
        const [[row]] = await pool.query('SELECT file_path, type FROM media WHERE id = ?', [id]);
        if (!row) { send({ status: 'progress', id, done: ++deleted, total: ids.length, skipped: true }); continue; }
        await pool.query('DELETE FROM media WHERE id = ?', [id]);
        if (deleteFile) {
          try { await fs.promises.unlink(row.file_path); }
          catch(e) { if (e.code !== 'ENOENT') errors.push({ id, error: e.message }); }
        }
        const thumbName = row.type === 'video' ? `v_${id}.jpg` : `p_${id}.jpg`;
        const thumbPath = path.resolve(__dirname, '../data/thumbs', thumbName);
        try { await fs.promises.unlink(thumbPath); } catch(_) {}
        deleted++;
        send({ status: 'progress', id, done: deleted, total: ids.length });
      } catch(e) {
        errors.push({ id, error: e.message });
        send({ status: 'progress', id, done: deleted, total: ids.length, error: e.message });
      }
    }

    send({ status: 'done', deleted, errors });
    if (!closed) res.end();
  } catch(e) { send({ status: 'error', error: e.message }); if (!closed) res.end(); }
});

// DELETE /admin/duplicates — delete a specific media file + DB record
router.delete('/duplicates/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[row]] = await pool.query('SELECT file_path, type FROM media WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM media WHERE id = ?', [id]);
    try { await fs.promises.unlink(row.file_path); } catch(e) {
      if (e.code !== 'ENOENT') throw e;
    }
    // Remove thumb (v_ for video, p_ for photo)
    const thumbName = row.type === 'video' ? `v_${id}.jpg` : `p_${id}.jpg`;
    const thumbPath = path.join(THUMB_DIR, thumbName);
    try { await fs.promises.unlink(thumbPath); } catch(_) {}
    res.json({ message: 'Deleted', id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════════════
   CLEAN MEDIA — native Node.js
   ══════════════════════════════════════════════════════════════════ */
router.post('/clean-media', async (req, res) => {
  const { dry_run = true, verbose = false } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let closed = false;
  const send = d => { if (!closed) try { res.write(`data: ${JSON.stringify(d)}\n\n`); if (res.flush) res.flush(); } catch(_) {} };
  const heartbeat = setInterval(() => { if (!closed) try { res.write(': keep-alive\n\n'); if (res.flush) res.flush(); } catch(_) {} }, 10000);
  res.on('close', () => { closed = true; clearInterval(heartbeat); });

  try {
    send({ status: 'started', dry_run, line: `${dry_run ? '[SIMULATION]' : '[RÉEL]'} Démarrage du nettoyage — ${new Date().toLocaleString('fr-FR')}` });

    // ── Phase 1 : entrées DB orphelines (fichier supprimé du disque) ─
    send({ status: 'phase', phase: 1, label: 'Vérification des entrées DB (fichiers manquants sur disque)' });
    const [allMedia] = await pool.query('SELECT id, file_path, type FROM media ORDER BY id');
    const dbPaths = new Set(allMedia.map(m => m.file_path));
    const total1  = allMedia.length;
    send({ status: 'progress', phase: 1, done: 0, total: total1, line: `${total1} médias dans la base de données` });

    const orphanedDb = [];
    for (let i = 0; i < allMedia.length; i++) {
      if (closed) break;
      const m = allMedia[i];
      let exists = true;
      try { await fs.promises.access(m.file_path, fs.constants.F_OK); } catch(_) { exists = false; }
      if (!exists) {
        orphanedDb.push(m);
        send({ status: 'progress', phase: 1, done: i + 1, total: total1, type: 'orphan_db', line: `⚠ Manquant sur disque : ${m.file_path}` });
      } else if (verbose && (i + 1) % 1000 === 0) {
        send({ status: 'progress', phase: 1, done: i + 1, total: total1, line: `✔ ${i + 1}/${total1} vérifiés…` });
      }
    }
    send({ status: 'phase_done', phase: 1, found: orphanedDb.length, done: total1, total: total1, line: `Phase 1 terminée — ${orphanedDb.length} entrée(s) DB orpheline(s)` });

    // ── Phase 2 : fichiers sur disque non indexés ─────────────────
    send({ status: 'phase', phase: 2, label: 'Recherche des fichiers non indexés sur disque' });
    const unindexed = [];
    let diskScanned = 0;

    async function walkDir(dir) {
      if (closed) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch(_) { return; }
      for (const e of entries) {
        if (closed) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walkDir(full);
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (VIDEO_EXTS.has(ext) || PHOTO_EXTS.has(ext)) {
            diskScanned++;
            if (!dbPaths.has(full)) {
              unindexed.push(full);
              if (verbose) send({ status: 'progress', phase: 2, done: diskScanned, total: 0, type: 'unindexed', line: `📄 Non indexé : ${full}` });
            } else if (verbose && diskScanned % 2000 === 0) {
              send({ status: 'progress', phase: 2, done: diskScanned, total: 0, line: `✔ ${diskScanned} fichiers parcourus…` });
            }
          }
        }
      }
    }

    await walkDir(MEDIA_DIR);
    send({ status: 'phase_done', phase: 2, found: unindexed.length, done: diskScanned, total: diskScanned, line: `Phase 2 terminée — ${diskScanned} fichier(s) parcouru(s), ${unindexed.length} non indexé(s)` });

    // ── Phase 3 : miniatures orphelines ──────────────────────────
    send({ status: 'phase', phase: 3, label: 'Vérification des miniatures orphelines' });
    const orphanThumbs = [];
    const dbIds = new Set(allMedia.map(m => m.id));
    try {
      const thumbFiles = await fs.promises.readdir(THUMB_DIR);
      for (const f of thumbFiles) {
        const m = f.match(/^[vp]_(\d+)\.(jpg|png|webp)$/);
        if (!m) continue;
        const id = Number(m[1]);
        if (!dbIds.has(id)) {
          orphanThumbs.push(path.join(THUMB_DIR, f));
          if (verbose) send({ status: 'progress', phase: 3, done: orphanThumbs.length, total: 0, type: 'orphan_thumb', line: `🖼 Miniature orpheline : ${f}` });
        }
      }
    } catch(_) {}
    send({ status: 'phase_done', phase: 3, found: orphanThumbs.length, done: orphanThumbs.length, total: orphanThumbs.length, line: `Phase 3 terminée — ${orphanThumbs.length} miniature(s) orpheline(s)` });

    // ── Actions réelles (si pas dry-run) ─────────────────────────
    let deletedDb = 0, deletedThumbs = 0;
    if (!dry_run) {
      if (orphanedDb.length) {
        send({ status: 'action', line: `🗑 Suppression de ${orphanedDb.length} entrée(s) DB orpheline(s)…` });
        for (const m of orphanedDb) {
          if (closed) break;
          await pool.query('DELETE FROM media WHERE id = ?', [m.id]);
          deletedDb++;
          if (verbose) send({ status: 'progress', phase: 4, done: deletedDb, total: orphanedDb.length, type: 'deleted_db', line: `✓ DB supprimé : [${m.id}] ${m.file_path}` });
        }
      }
      if (orphanThumbs.length) {
        send({ status: 'action', line: `🗑 Suppression de ${orphanThumbs.length} miniature(s) orpheline(s)…` });
        for (const t of orphanThumbs) {
          if (closed) break;
          try { await fs.promises.unlink(t); deletedThumbs++; } catch(_) {}
          if (verbose) send({ status: 'progress', phase: 4, done: deletedThumbs, total: orphanThumbs.length, type: 'deleted_thumb', line: `✓ Miniature supprimée : ${path.basename(t)}` });
        }
      }
    }

    // ── Résumé final ─────────────────────────────────────────────
    send({
      status: 'done', dry_run,
      orphaned_db: orphanedDb.length, unindexed_files: unindexed.length,
      orphaned_thumbs: orphanThumbs.length, deleted_db: deletedDb, deleted_thumbs: deletedThumbs,
      line: [
        '',
        '════════════════════════════════════════',
        `  ${dry_run ? '📋 SIMULATION — aucune modification effectuée' : '✅ NETTOYAGE TERMINÉ'}`,
        `  Entrées DB orphelines    : ${orphanedDb.length}${!dry_run ? ` → ${deletedDb} supprimée(s)` : ''}`,
        `  Fichiers non indexés     : ${unindexed.length}`,
        `  Miniatures orphelines    : ${orphanThumbs.length}${!dry_run ? ` → ${deletedThumbs} supprimée(s)` : ''}`,
        '════════════════════════════════════════',
      ].join('\n'),
    });
    if (!closed) res.end();
  } catch(e) {
    send({ status: 'error', error: e.message, line: `❌ Erreur fatale : ${e.message}` });
    if (!closed) res.end();
  } finally {
    clearInterval(heartbeat);
  }
});

/* ══════════════════════════════════════════════════════════════════
   MEDIA MANAGEMENT
   ══════════════════════════════════════════════════════════════════ */
router.delete('/media/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[row]] = await pool.query('SELECT file_path, type FROM media WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (req.query.delete_file === '1') {
      try { await fs.promises.unlink(row.file_path); } catch(e) { if (e.code !== 'ENOENT') throw e; }
    }
    await pool.query('DELETE FROM media WHERE id = ?', [id]);
    const thumbName = row.type === 'video' ? `v_${id}.jpg` : `p_${id}.jpg`;
    const thumbPath = path.join(THUMB_DIR, thumbName);
    try { await fs.promises.unlink(thumbPath); } catch(_) {}
    res.json({ message: 'Deleted', id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
