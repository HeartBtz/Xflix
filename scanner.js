/**
 * scanner.js — Media scanner, thumbnail generator, enrichment pipeline
 *
 * Responsibilities
 * ────────────────
 * 1. runScan(mode)               — index, enrich and generate thumbnails under
 *                                   one maintenance lock and progress lifecycle.
 * 2. enrichDurations(concurrency, cancelled) — fill in video metadata via ffprobe.
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
 * - Insertions use deduplicated batches of 500 rows under the maintenance lock.
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
const { execFile } = require('child_process');
const { resolveInside, writeAtomic } = require('./lib/media-files');
const { withMaintenance } = require('./lib/maintenance');
const { upsertPerformer, batchInsertMedia, updatePerformerCounts, getAllExistingFilePaths, pool,
        getOrCreateTag, setMediaTags } = require('./db');
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });

const MEDIA_DIR = process.env.MEDIA_DIR;

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

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';
let sharp;
try { sharp = require('sharp'); } catch(e) { sharp = null; }

const THUMB_DIR = process.env.THUMB_DIR || path.join(__dirname, 'data', 'thumbs');

// ─── Scan State ────────────────────────────────────────────────

let scanProgress = {
  running: false,
  phase: 'idle',
  mode: 'all',
  total: 0,
  done: 0,
  completed: false,
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
  scanProgress.cancelled = true;
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
async function getVideoMeta(filePath) {
  filePath = await resolveInside(MEDIA_DIR, filePath);
  if (!(await fs.promises.stat(filePath)).isFile()) throw new Error('Media path is not a regular file');
  return new Promise((resolve, reject) => {
    execFile(FFPROBE_PATH, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath,
    ], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT' || err.code === 'EACCES') return reject(Object.assign(new Error('Unable to execute ffprobe', { cause: err }), { code: 'EPROBE' }));
        return resolve(null);
      }
      let meta;
      try { meta = JSON.parse(stdout); } catch (_) { return resolve(null); }
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
  const tagIds = [];
  for (const name of tags) tagIds.push(await getOrCreateTag(name));
  await setMediaTags(mediaId, tagIds);
}

async function generateVideoThumb(filePath, mediaId) {
  return generateThumb(filePath, mediaId, 'v', async (source, output) => {
    const makeAt = seconds => new Promise(resolve => {
    execFile(FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', source,
      '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', '-y', output,
    ], { timeout: 45_000, maxBuffer: 2 * 1024 * 1024 }, error => {
      let written = false;
      try { written = fs.statSync(output).size > 0; } catch (_) {}
      resolve(!error && written);
    });
    });
    if (!await makeAt(5)) {
      await fs.promises.rm(output, { force: true });
      if (!await makeAt(0)) throw new Error('Video thumbnail generation failed');
    }
  });
}

async function generatePhotoThumb(filePath, mediaId) {
  if (!sharp) return null;
  return generateThumb(filePath, mediaId, 'p', (source, output) => sharp(source, { limitInputPixels: 40_000_000, failOn: 'error' })
    .resize(320, 320, { fit: 'cover', withoutEnlargement: true })
    .jpeg({ quality: 75, progressive: true })
    .toFile(output));
}

async function generateThumb(filePath, mediaId, prefix, render) {
  if (!Number.isSafeInteger(Number(mediaId)) || Number(mediaId) < 1) throw new Error('Invalid media ID');
  const thumbName = `${prefix}_${Number(mediaId)}.jpg`;
  const thumbPath = path.join(THUMB_DIR, thumbName);
  if (thumbGenerating.has(thumbPath)) return thumbGenerating.get(thumbPath);
  const p = (async () => {
    const source = await resolveInside(MEDIA_DIR, filePath);
    if (!(await fs.promises.stat(source)).isFile()) throw new Error('Media path is not a regular file');
    await fs.promises.mkdir(THUMB_DIR, { recursive: true });
    const destination = await resolveInside(THUMB_DIR, thumbPath, { allowMissing: true });
    try {
      const stat = await fs.promises.stat(destination);
      if (stat.isFile() && stat.size > 0) return destination;
      if (stat.isFile()) await fs.promises.unlink(destination);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { return await writeAtomic(THUMB_DIR, thumbPath, output => render(source, output)); }
    catch (error) {
      if (error.code === 'EACCES' || error.code === 'ENOTDIR') throw error;
      return null;
    }
  })().finally(() => thumbGenerating.delete(thumbPath));
  thumbGenerating.set(thumbPath, p);
  return p;
}

// ─── Concurrency Helper ────────────────────────────────────────

async function runConcurrent(tasks, concurrency, cancelled) {
  const queue = [...tasks];
  let failed = false;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    try {
      while (queue.length && !failed && !cancelled()) await queue.shift()();
    } catch (error) { failed = true; throw error; }
  });
  // Do not release the maintenance lock while sibling workers are still running.
  const results = await Promise.allSettled(workers);
  const rejection = results.find(result => result.status === 'rejected');
  if (rejection) throw rejection.reason;
}

// ─── Directory Walker ─────────────────────────────────────────

// Async generator: walk directory tree, yielding one file path at a time.
// Yields after each subdirectory to let the event loop breathe.
async function* walkFiles(dirPath, cancelled) {
  if (cancelled()) return;
  await resolveInside(MEDIA_DIR, dirPath);
  if (cancelled()) return;
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  const subdirs = [];
  for (const entry of entries) {
    if (cancelled()) return;
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) subdirs.push(fullPath);
    else if (entry.isFile()) yield fullPath;
  }
  // Recurse into subdirs — each readdir call is async so event loop can breathe
  for (const sub of subdirs) {
    if (cancelled()) return;
    yield* walkFiles(sub, cancelled);
  }
}

// ─── Main Scan ────────────────────────────────────────────────

const BATCH_SIZE = 500;

async function runScan(mode = 'all', onProgress = null, cancelPredicate = () => false) {
  if (!['all', 'photos', 'videos'].includes(mode)) throw new Error('Invalid mode');
  if (typeof cancelPredicate !== 'function') throw new Error('Cancellation predicate must be a function');
  if (scanProgress.running) throw Object.assign(new Error('Scan already in progress'), { status: 409 });
  const scanPhotos = mode === 'all' || mode === 'photos';
  const scanVideos = mode === 'all' || mode === 'videos';
  // Reserve local state before the first await, including lock acquisition/release.
  cancelRequested = false;
  scanProgress = {
    running: true, phase: 'index', mode, total: 0, done: 0, completed: false, skipped: 0, errors: 0,
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
    cancelled: false, currentPerformer: null,
  };
  const cancelled = () => {
    if (cancelRequested || cancelPredicate()) scanProgress.cancelled = true;
    return scanProgress.cancelled;
  };
  const notifyProgress = () => { if (onProgress) try { onProgress({ ...scanProgress }); } catch(_) {} };

  try {
    await withMaintenance(async () => {
      notifyProgress();
      const entries = cancelled() ? [] : await fs.promises.readdir(MEDIA_DIR, { withFileTypes: true });
      const performerDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
      const allExisting = cancelled() ? new Map() : await getAllExistingFilePaths();

      for (const dir of performerDirs) {
        if (cancelled()) break;
        const dirPath = path.resolve(MEDIA_DIR, dir.name);
        await resolveInside(MEDIA_DIR, dirPath);
        if (cancelled()) break;
        const performerId = await upsertPerformer(dir.name, dirPath);
        const existingPaths = allExisting.get(performerId) || new Set();
        scanProgress.currentPerformer = dir.name;
        notifyProgress();
        let batch = [];
        const flushBatch = async () => {
          if (!batch.length || cancelled()) return;
          const inserted = await batchInsertMedia(batch);
          scanProgress.done += inserted;
          scanProgress.skipped += batch.length - inserted;
          batch = [];
          notifyProgress();
        };

        for await (const filePath of walkFiles(dirPath, cancelled)) {
          if (cancelled()) break;
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
          try {
            const validated = await resolveInside(MEDIA_DIR, filePath);
            if (cancelled()) break;
            const stat = await fs.promises.stat(validated);
            if (cancelled()) break;
            if (!stat.isFile()) throw new Error('Media path is not a regular file');
            scanProgress.total++;
            batch.push([
              performerId, path.basename(filePath), filePath,
              isVideo ? 'video' : 'photo',
              MIME_MAP[ext] || (isVideo ? 'video/mp4' : 'image/jpeg'),
              stat.size, null, null, null,
            ]);
          } catch(e) {
            if (e.code !== 'ENOENT') throw e;
            scanProgress.errors++;
            scanProgress.lastError = e.message;
          }
          // DB failures must not be swallowed by the missing-file handler.
          if (batch.length >= BATCH_SIZE) await flushBatch();
        }
        await flushBatch();
      }
      // Finalize counts for already committed batches even after cancellation.
      if (scanProgress.done || !cancelled()) await updatePerformerCounts();
      scanProgress.currentPerformer = null;
      if (!cancelled() && scanVideos) {
        scanProgress.phase = 'enrich';
        notifyProgress();
        await enrichDurations(3, cancelled);
      }
      if (!cancelled()) {
        scanProgress.phase = 'thumbs';
        notifyProgress();
        await generateMissingThumbs(3, cancelled);
      }
    });
    scanProgress.completed = !cancelled() && scanProgress.errors === 0;
    scanProgress.phase = scanProgress.cancelled ? 'cancelled' : scanProgress.errors ? 'error' : 'done';
  } catch (error) {
    scanProgress.phase = 'error';
    scanProgress.lastError = error.message;
    scanProgress.errors++;
    throw error;
  } finally {
    scanProgress.running = false;
    scanProgress.finishedAt = new Date().toISOString();
    scanProgress.currentPerformer = null;
    notifyProgress();
  }
  return getProgress();
}

/**
 * POST-SCAN: Extract full video metadata (codec, fps, bitrate, audio, duration)
 * and write auto-tags for each video that is still missing codec info.
 * Run after a scan; replaces the old enrichDurations function.
 */
async function enrichVideoMeta(concurrency = 3, cancelled = () => false) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Concurrency must be an integer from 1 to 16');
  if (typeof cancelled !== 'function') throw new Error('Cancellation predicate must be a function');
  if (cancelled()) return;
  return withMaintenance(async () => {
    let cursor = 0;
    while (!cancelled()) {
      const [rows] = await pool.query(
        "SELECT id, file_path FROM media WHERE type='video' AND (codec IS NULL OR duration IS NULL) AND id > ? ORDER BY id LIMIT ?",
        [cursor, BATCH_SIZE]
      );
      if (!rows.length || cancelled()) return;
      const tasks = rows.map(row => async () => {
        let meta;
        try { meta = await getVideoMeta(row.file_path); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
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
        if (meta.height) await autoTagMedia(row.id, meta);
      });
      await runConcurrent(tasks, concurrency, cancelled);
      cursor = rows[rows.length - 1].id;
    }
  });
}

// Backward-compatible alias (used in routes/api.js and routes/admin.js)
const enrichDurations = enrichVideoMeta;

/**
 * Génère les miniatures manquantes en arrière-plan après un scan.
 * Traite les 300 médias les plus récents sans thumb, avec `concurrency` workers.
 */
async function generateMissingThumbs(concurrency = 3, cancelled = () => false) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Concurrency must be an integer from 1 to 16');
  if (typeof cancelled !== 'function') throw new Error('Cancellation predicate must be a function');
  if (cancelled()) return;
  return withMaintenance(async () => {
    if (cancelled()) return;
    const [rows] = await pool.query(
      'SELECT id, file_path, type FROM media WHERE thumb_path IS NULL ORDER BY id DESC LIMIT ?',
      [300]
    );
    if (!rows.length || cancelled()) return;
    console.log(`[thumbs] Génération de ${rows.length} miniature(s) manquante(s)…`);
    const tasks = rows.map(m => async () => {
      const tp = m.type === 'video'
        ? await generateVideoThumb(m.file_path, m.id)
        : await generatePhotoThumb(m.file_path, m.id);
      if (!tp) throw new Error(`Thumbnail generation failed for media ${m.id}`);
      await pool.query('UPDATE media SET thumb_path = ? WHERE id = ?', [tp, m.id]);
    });
    await runConcurrent(tasks, concurrency, cancelled);
    if (!cancelled()) console.log('[thumbs] Génération terminée.');
  });
}

module.exports = {
  // Constants (shared with admin.js and other routes)
  MEDIA_DIR, THUMB_DIR, VIDEO_EXTS, PHOTO_EXTS, MIME_MAP,
  // Functions
  runScan, getProgress, cancelScan,
  getVideoMeta, generateVideoThumb, generatePhotoThumb, enrichVideoMeta, enrichDurations, generateMissingThumbs,
};
