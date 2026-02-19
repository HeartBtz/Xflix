/**
 * scanner.js — Media scanner, thumbnail generator, enrichment pipeline
 *
 * Responsibilities
 * ────────────────
 * 1. scanDirectory(mode)         — walk MEDIA_DIR, upsert performers and
 *                                   batch-insert new media rows. Supports
 *                                   live progress via SSE callback.
 * 2. enrichDurations(concurrency) — post-scan background job: fill in
 *                                   video durations using ffprobe.
 * 3. generateMissingThumbs()     — post-scan background job: generate
 *                                   JPEG thumbnails for recent media that
 *                                   lack one.
 * 4. generateVideoThumb()        — on-demand: extract a single JPEG frame
 *                                   from a video via ffmpeg.
 * 5. generatePhotoThumb()        — on-demand: resize a photo to 320px via
 *                                   sharp.
 *
 * Design decisions
 * ────────────────
 * - walkFiles() is an async generator so large directories (60 000+
 *   files) don't block the event loop between readdir calls.
 * - Insertions use INSERT IGNORE batches of 500 rows to minimise
 *   round-trips while staying idempotent.
 * - Scan state is a plain object in module scope — one scan at a time.
 * - ffmpeg / sharp are required lazily with try/catch so the app still
 *   starts (without thumb generation) if those binaries are absent.
 *
 * Expected directory layout under MEDIA_DIR
 * ────────────────────────────────────────
 *   MEDIA_DIR/
 *   ├── PerformerName/       ← becomes one performers row
 *   │   ├── *.mp4 / *.jpg      ← any depth inside the subdir
 *   │   └── nested/sub/dirs/
 *   └── AnotherPerformer/
 */
const fs = require('fs');
const path = require('path');
const { upsertPerformer, batchInsertMedia, updatePerformerCounts, getAllExistingFilePaths, pool,
        getOrCreateTag, setMediaTags } = require('./db');
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

/**
 * Parse an ffprobe avg_frame_rate fraction string (e.g. "30000/1001") to a
 * rounded float. Returns null when the input is invalid.
 */
function parseFraction(str) {
  if (!str) return null;
  const parts = str.split('/').map(Number);
  if (parts.length !== 2 || !parts[1]) return parts[0] || null;
  return Math.round((parts[0] / parts[1]) * 100) / 100;
}

/**
 * Run ffprobe on a video file and return structured metadata.
 * All fields may be null when the stream does not carry that information.
 */
function getVideoMeta(filePath) {
  return new Promise((resolve) => {
    if (!ffmpeg) return resolve(null);
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err || !meta) return resolve(null);
      const video = meta.streams?.find(s => s.codec_type === 'video');
      const audio = meta.streams?.find(s => s.codec_type === 'audio');
      resolve({
        duration:        meta.format?.duration        ? Number(meta.format.duration)           : null,
        codec:           video?.codec_name            || null,
        width:           video?.width                 || null,
        height:          video?.height                || null,
        bitrate:         meta.format?.bit_rate        ? Math.round(Number(meta.format.bit_rate) / 1000) : null,
        fps:             parseFraction(video?.avg_frame_rate),
        audioCodec:      audio?.codec_name            || null,
        audioSampleRate: audio?.sample_rate           ? Number(audio.sample_rate) : null,
        audioChannels:   audio?.channels              || null,
      });
    });
  });
}

// Backward-compatible thin wrapper
function getVideoDuration(filePath) {
  return getVideoMeta(filePath).then(m => m?.duration ?? null);
}

/**
 * Create or look up resolution/codec/duration auto-tags for a video
 * and write them to media_tags.
 */
async function autoTagMedia(mediaId, meta) {
  const tags = [];

  // Resolution
  if      (meta.height >= 2160) tags.push('4K');
  else if (meta.height >= 1080) tags.push('1080p');
  else if (meta.height >= 720)  tags.push('720p');
  else if (meta.height)         tags.push('SD');

  // Codec — only noteworthy non-H.264 variants
  const codec = (meta.codec || '').toLowerCase();
  if      (codec === 'hevc' || codec === 'h265') tags.push('H.265');
  else if (codec === 'vp9')                      tags.push('VP9');
  else if (codec === 'av1')                      tags.push('AV1');

  // Duration bracket
  if (meta.duration) {
    if      (meta.duration < 300)  tags.push('Court');
    else if (meta.duration < 1800) tags.push('Moyen');
    else                           tags.push('Long');
  }

  if (!tags.length) return;
  const tagIds = await Promise.all(tags.map(name => getOrCreateTag(name)));
  await setMediaTags(mediaId, tagIds);
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
 * POST-SCAN: Extract full video metadata (codec, fps, bitrate, audio, duration)
 * and write auto-tags for each video that is still missing codec info.
 * Run after a scan; replaces the old enrichDurations function.
 */
async function enrichVideoMeta(concurrency = 3) {
  if (!ffmpeg) return;
  try {
    const [rows] = await pool.query(
      "SELECT id, file_path FROM media WHERE type='video' AND (codec IS NULL OR duration IS NULL) LIMIT 2000"
    );
    if (!rows.length) return;
    const tasks = rows.map(row => async () => {
      try {
        const meta = await getVideoMeta(row.file_path);
        if (!meta) return;
        // COALESCE keeps existing non-null values intact (idempotent on re-runs)
        await pool.query(
          `UPDATE media SET
             duration          = COALESCE(duration,          ?),
             codec             = COALESCE(codec,             ?),
             audio_codec       = COALESCE(audio_codec,       ?),
             bitrate           = COALESCE(bitrate,           ?),
             fps               = COALESCE(fps,               ?),
             audio_sample_rate = COALESCE(audio_sample_rate, ?),
             audio_channels    = COALESCE(audio_channels,    ?),
             width             = COALESCE(width,             ?),
             height            = COALESCE(height,            ?)
           WHERE id = ?`,
          [meta.duration, meta.codec, meta.audioCodec, meta.bitrate, meta.fps,
           meta.audioSampleRate, meta.audioChannels, meta.width, meta.height, row.id]
        );
        if (meta.height) await autoTagMedia(row.id, meta).catch(() => {});
      } catch(e) { /* skip bad files */ }
    });
    await runConcurrent(tasks, concurrency);
  } catch(e) { console.error('[enrichVideoMeta]', e.message); }
}

// Backward-compatible alias (used in routes/api.js and routes/admin.js)
const enrichDurations = enrichVideoMeta;

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
  generateVideoThumb, generatePhotoThumb, enrichVideoMeta, enrichDurations, generateMissingThumbs,
};
