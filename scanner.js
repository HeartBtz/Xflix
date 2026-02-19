const fs = require('fs');
const path = require('path');
const { upsertPerformer, batchInsertMedia, updatePerformerCounts, getAllExistingFilePaths, pool } = require('./db');
require('dotenv').config();

const MEDIA_DIR = process.env.MEDIA_DIR || '/home/coder/OF';

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.flv', '.m4v', '.ts', '.3gp']);
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif', '.avif']);

const MIME_MAP = {
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv', '.m4v': 'video/mp4', '.ts': 'video/mp2t',
  '.3gp': 'video/3gpp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif',
};

let ffmpeg, ffprobe, sharp;
try { ffmpeg = require('fluent-ffmpeg'); } catch(e) { ffmpeg = null; }
try { ffprobe = require('ffprobe-static'); if (ffmpeg) ffmpeg.setFfprobePath(ffprobe.path); } catch(e) {}
try { sharp = require('sharp'); } catch(e) { sharp = null; }

const THUMB_DIR = process.env.THUMB_DIR || path.join(__dirname, 'data', 'thumbs');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// ─── Scan State ────────────────────────────────────────────────

let scanProgress = {
  running: false,
  mode: 'all',
  total: 0,
  done: 0,
  skipped: 0,
  errors: 0,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  cancelled: false,
};

let cancelRequested = false;

function getProgress() { return { ...scanProgress }; }
function cancelScan() {
  if (!scanProgress.running) return false;
  cancelRequested = true;
  return true;
}

// ─── Thumbnail Generation ──────────────────────────────────────

// In-progress dedup guard
const thumbGenerating = new Map();

function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    if (!ffmpeg) return resolve(null);
    ffmpeg.ffprobe(filePath, (err, meta) => resolve(err || !meta ? null : (meta.format?.duration || null)));
  });
}

async function generateVideoThumb(filePath, mediaId) {
  if (!ffmpeg) return null;
  const thumbName = `v_${mediaId}.jpg`;
  const thumbPath = path.join(THUMB_DIR, thumbName);
  if (fs.existsSync(thumbPath)) return thumbPath;
  if (thumbGenerating.has(thumbPath)) return thumbGenerating.get(thumbPath);
  const p = new Promise((resolve) => {
    try {
      ffmpeg(filePath)
        .on('error', () => { thumbGenerating.delete(thumbPath); resolve(null); })
        .on('end',   () => { thumbGenerating.delete(thumbPath); resolve(thumbPath); })
        .screenshots({ count: 1, timemarks: ['10%'], folder: THUMB_DIR, filename: thumbName, size: '320x?' });
    } catch(e) { thumbGenerating.delete(thumbPath); resolve(null); }
  });
  thumbGenerating.set(thumbPath, p);
  return p;
}

async function generatePhotoThumb(filePath, mediaId) {
  if (!sharp) return null;
  const thumbName = `p_${mediaId}.jpg`;
  const thumbPath = path.join(THUMB_DIR, thumbName);
  if (fs.existsSync(thumbPath)) return thumbPath;
  if (thumbGenerating.has(thumbPath)) return thumbGenerating.get(thumbPath);
  const p = sharp(filePath)
    .resize(320, 320, { fit: 'cover', withoutEnlargement: true })
    .jpeg({ quality: 75, progressive: true })
    .toFile(thumbPath)
    .then(() => thumbPath)
    .catch(() => null)
    .finally(() => thumbGenerating.delete(thumbPath));
  thumbGenerating.set(thumbPath, p);
  return p;
}

// ─── Concurrency Helper ────────────────────────────────────────

async function runConcurrent(tasks, concurrency) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) { const t = queue.shift(); if (t) await t(); }
  });
  await Promise.all(workers);
}

// ─── Directory Walker ─────────────────────────────────────────

// Async generator: walk directory tree, yielding one file path at a time.
// Yields after each subdirectory to let the event loop breathe.
async function* walkFiles(dirPath) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch(e) { return; }

  const subdirs = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) subdirs.push(fullPath);
    else if (entry.isFile()) yield fullPath;
  }
  // Recurse into subdirs — each readdir call is async so event loop can breathe
  for (const sub of subdirs) {
    yield* walkFiles(sub);
  }
}

// ─── Main Scan ────────────────────────────────────────────────

const BATCH_SIZE = 500;

async function scanDirectory(mode = 'all', onProgress = null) {
  if (scanProgress.running) throw new Error('Scan already in progress');
  if (!['all', 'photos', 'videos'].includes(mode)) throw new Error('Invalid mode');

  const scanPhotos = mode === 'all' || mode === 'photos';
  const scanVideos = mode === 'all' || mode === 'videos';

  cancelRequested = false;
  scanProgress = {
    running: true, mode, total: 0, done: 0, skipped: 0, errors: 0,
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
    cancelled: false, currentPerformer: null,
  };

  const notifyProgress = () => { if (onProgress) try { onProgress({ ...scanProgress }); } catch(_) {} };

  try {
    if (!fs.existsSync(MEDIA_DIR)) throw new Error(`MEDIA_DIR not found: ${MEDIA_DIR}`);

    const entries = fs.readdirSync(MEDIA_DIR, { withFileTypes: true });
    const performerDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));

    // Pre-load ALL existing file paths in one query (avoids N roundtrips)
    const allExisting = await getAllExistingFilePaths();

    for (const dir of performerDirs) {
      if (cancelRequested) break;

      const dirPath = path.join(MEDIA_DIR, dir.name);
      const performerId = await upsertPerformer(dir.name, dirPath);

      // Use pre-loaded set for this performer (no extra DB query)
      const existingPaths = allExisting.get(performerId) || new Set();

      // Notify: starting walk for this performer
      scanProgress.currentPerformer = dir.name;
      notifyProgress();

      // Walk async — each readdir is non-blocking, event loop gets chances to flush SSE
      let batch = [];
      const flushBatch = async () => {
        if (!batch.length) return;
        await batchInsertMedia(batch);
        scanProgress.done += batch.length;
        batch = [];
        notifyProgress();
      };

      for await (const filePath of walkFiles(dirPath)) {
        if (cancelRequested) break;
        const ext = path.extname(filePath).toLowerCase();
        const isVideo = VIDEO_EXTS.has(ext);
        const isPhoto = PHOTO_EXTS.has(ext);
        if (!isVideo && !isPhoto) continue;
        if (isVideo && !scanVideos) continue;
        if (isPhoto && !scanPhotos) continue;

        if (existingPaths.has(filePath)) {
          scanProgress.skipped++;
          continue;
        }

        // New file — stat and queue
        try {
          const stat = await fs.promises.stat(filePath);
          scanProgress.total++;
          batch.push([
            performerId,
            path.basename(filePath),
            filePath,
            isVideo ? 'video' : 'photo',
            MIME_MAP[ext] || (isVideo ? 'video/mp4' : 'image/jpeg'),
            stat.size, null, null, null,
          ]);
          if (batch.length >= BATCH_SIZE) await flushBatch();
        } catch(e) {
          scanProgress.errors++;
          scanProgress.lastError = e.message;
        }
      }
      await flushBatch();
    }

    await updatePerformerCounts();
    scanProgress.running = false;
    scanProgress.cancelled = cancelRequested;
    scanProgress.currentPerformer = null;
    scanProgress.finishedAt = new Date().toISOString();
    notifyProgress();
    cancelRequested = false;
  } catch(e) {
    scanProgress.running = false;
    scanProgress.finishedAt = new Date().toISOString();
    scanProgress.lastError = e.message;
    throw e;
  }
}

/**
 * POST-SCAN: Enrich video durations in background with limited concurrency.
 * Run after a scan to fill in duration for videos that don't have it.
 */
async function enrichDurations(concurrency = 3) {
  if (!ffmpeg) return;
  try {
    const [rows] = await pool.query(
      "SELECT id, file_path FROM media WHERE type='video' AND duration IS NULL LIMIT 2000"
    );
    if (!rows.length) return;
    const tasks = rows.map(row => async () => {
      try {
        const duration = await getVideoDuration(row.file_path);
        if (duration) await pool.query('UPDATE media SET duration = ? WHERE id = ?', [duration, row.id]);
      } catch(e) { /* skip */ }
    });
    await runConcurrent(tasks, concurrency);
  } catch(e) { console.error('[enrichDurations]', e.message); }
}

/**
 * Génère les miniatures manquantes en arrière-plan après un scan.
 * Traite les `limit` médias les plus récents sans thumb, avec `concurrency` workers.
 */
async function generateMissingThumbs(limit = 300, concurrency = 3) {
  try {
    const [rows] = await pool.query(
      'SELECT id, file_path, type FROM media WHERE thumb_path IS NULL ORDER BY id DESC LIMIT ?',
      [limit]
    );
    if (!rows.length) return;
    console.log(`[thumbs] Génération de ${rows.length} miniature(s) manquante(s)…`);
    const tasks = rows.map(m => async () => {
      try {
        const tp = m.type === 'video'
          ? await generateVideoThumb(m.file_path, m.id)
          : await generatePhotoThumb(m.file_path, m.id);
        if (tp) await pool.query('UPDATE media SET thumb_path = ? WHERE id = ?', [tp, m.id]);
      } catch(_) {}
    });
    await runConcurrent(tasks, concurrency);
    console.log('[thumbs] Génération terminée.');
  } catch(e) { console.error('[generateMissingThumbs]', e.message); }
}

module.exports = {
  // Constants (shared with admin.js and other routes)
  MEDIA_DIR, THUMB_DIR, VIDEO_EXTS, PHOTO_EXTS, MIME_MAP,
  // Functions
  scanDirectory, getProgress, cancelScan,
  generateVideoThumb, generatePhotoThumb, enrichDurations, generateMissingThumbs,
};
