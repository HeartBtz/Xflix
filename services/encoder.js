/**
 * services/encoder.js — Video re-encoding engine
 *
 * Manages a queue of encode jobs with concurrent workers.
 * Each worker can use a different encoder (GPU or CPU).
 * Progress is tracked per-job and broadcast via a simple event system.
 *
 * Supported target codecs: h265 (HEVC), av1
 * Supported backends: NVIDIA NVENC, VA-API, Intel QSV, CPU (libx265/SVT-AV1)
 */
'use strict';

const { spawn }   = require('child_process');
const path         = require('path');
const fs           = require('fs');
const { pool }     = require('../db');
const gpuDetect    = require('./gpu-detect');

/* ── Constants ───────────────────────────────────────────── */
const ENCODE_DIR = path.resolve(__dirname, '../data/encoded');

// Make sure encoded dir exists
fs.mkdirSync(ENCODE_DIR, { recursive: true });

/* ── In-memory state ─────────────────────────────────────── */
const _listeners = new Set();       // Set<(event) => void>
const _activeJobs = new Map();      // jobId → { process, cancelled, deviceKey }
const _dispatchedJobs = new Set();  // IDs currently dispatched (prevent race conditions)
const _deviceUsage = new Map();     // deviceKey → number of active encodes

// Max concurrent encode workers
let _maxWorkers = 2;
let _running = 0;

/* ── Device tracking helpers ───────────────────────────── */
function getDeviceKey(preset) {
  if (!preset) return 'cpu';
  if (preset.type === 'nvidia') return `nvidia_${preset.gpuIndex}`;
  if (preset.type === 'vaapi') return `vaapi_${preset.renderDevice}`;
  if (preset.type === 'qsv') return 'qsv';
  return 'cpu';
}

function acquireDevice(deviceKey) {
  _deviceUsage.set(deviceKey, (_deviceUsage.get(deviceKey) || 0) + 1);
}

function releaseDevice(deviceKey) {
  if (deviceKey) {
    _deviceUsage.set(deviceKey, Math.max(0, (_deviceUsage.get(deviceKey) || 1) - 1));
  }
}

function isDeviceAvailable(preset) {
  const key = getDeviceKey(preset);
  const usage = _deviceUsage.get(key) || 0;
  // GPU encoders: max 2 concurrent per device (NVENC consumer limit is ~5 sessions)
  if (['nvidia', 'vaapi', 'qsv'].includes(preset.type)) return usage < 2;
  return true; // CPU limited by global _maxWorkers
}

/**
 * Resolve a preset ID (possibly a group like "nvidia_h265") to a specific device preset.
 * For groups, picks the least-busy available device.
 */
async function resolvePreset(presetId, caps) {
  const preset = caps.presets.find(p => p.id === presetId);
  if (!preset) return null;

  // Not a group → return directly
  if (preset.type !== 'nvidia_group' && preset.type !== 'vaapi_group') return preset;

  // Group → pick least-busy matching device
  const matchType = preset.type === 'nvidia_group' ? 'nvidia' : 'vaapi';
  const candidates = caps.presets.filter(p => p.type === matchType && p.encoder === preset.encoder);

  let best = null, bestUsage = Infinity;
  for (const c of candidates) {
    const key = getDeviceKey(c);
    const usage = _deviceUsage.get(key) || 0;
    if (isDeviceAvailable(c) && usage < bestUsage) {
      bestUsage = usage;
      best = c;
    }
  }
  return best;
}

/** Release all resources for a dispatched job */
function releaseSlot(jobId, deviceKey) {
  _dispatchedJobs.delete(jobId);
  _running = Math.max(0, _running - 1);
  releaseDevice(deviceKey);
  setImmediate(processQueue);
}

/* ── Event bus ───────────────────────────────────────────── */
function emit(event) {
  for (const fn of _listeners) {
    try { fn(event); } catch {}
  }
}

function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/* ── FFmpeg argument builders ────────────────────────────── */

/**
 * Build ffmpeg args for a given encoder preset.
 * Pre-input flags (like -hwaccel) must appear before -i.
 */
function buildFfmpegArgs(inputPath, outputPath, preset, quality = 'balanced') {
  // Quality presets: fast (lower quality), balanced, quality (slow)
  const crf = quality === 'fast' ? 32 : quality === 'quality' ? 22 : 28;
  const speed = quality === 'fast' ? 'fast' : quality === 'quality' ? 'slow' : 'medium';

  const pre = ['-hide_banner', '-y'];  // before -i
  const post = [
    '-map', '0:v:0', '-map', '0:a?',   // first video + all audio
    '-c:a', 'copy',                       // copy audio
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-stats_period', '0.5',
  ];

  switch (preset.encoder) {
    /* ── NVIDIA NVENC ─────────────────────────────────── */
    case 'hevc_nvenc':
      return [...pre,
        '-hwaccel', 'cuda', '-hwaccel_device', String(preset.gpuIndex ?? 0),
        '-i', inputPath,
        ...post,
        '-c:v', 'hevc_nvenc',
        '-preset', speed === 'slow' ? 'p7' : speed === 'fast' ? 'p1' : 'p4',
        '-rc:v', 'vbr', '-cq', String(crf), '-b:v', '0',
        outputPath,
      ];

    case 'av1_nvenc':
      return [...pre,
        '-hwaccel', 'cuda', '-hwaccel_device', String(preset.gpuIndex ?? 0),
        '-i', inputPath,
        ...post,
        '-c:v', 'av1_nvenc',
        '-preset', speed === 'slow' ? 'p7' : speed === 'fast' ? 'p1' : 'p4',
        '-rc:v', 'vbr', '-cq', String(crf), '-b:v', '0',
        outputPath,
      ];

    /* ── VA-API (AMD / Intel) ─────────────────────────── */
    case 'hevc_vaapi':
      return [...pre,
        '-vaapi_device', preset.renderDevice || '/dev/dri/renderD128',
        '-i', inputPath,
        ...post,
        '-vf', 'format=nv12,hwupload',
        '-c:v', 'hevc_vaapi',
        '-rc_mode', 'CQP', '-qp', String(crf),
        outputPath,
      ];

    case 'av1_vaapi':
      return [...pre,
        '-vaapi_device', preset.renderDevice || '/dev/dri/renderD128',
        '-i', inputPath,
        ...post,
        '-vf', 'format=nv12,hwupload',
        '-c:v', 'av1_vaapi',
        '-rc_mode', 'CQP', '-qp', String(crf),
        outputPath,
      ];

    /* ── Intel QSV ────────────────────────────────────── */
    case 'hevc_qsv':
      return [...pre,
        '-hwaccel', 'qsv',
        '-i', inputPath,
        ...post,
        '-c:v', 'hevc_qsv',
        '-global_quality', String(crf),
        '-preset', speed === 'slow' ? 'veryslow' : speed === 'fast' ? 'veryfast' : 'medium',
        outputPath,
      ];

    case 'av1_qsv':
      return [...pre,
        '-hwaccel', 'qsv',
        '-i', inputPath,
        ...post,
        '-c:v', 'av1_qsv',
        '-global_quality', String(crf),
        outputPath,
      ];

    /* ── CPU libx265 ──────────────────────────────────── */
    case 'libx265':
      return [...pre,
        '-i', inputPath,
        ...post,
        '-c:v', 'libx265',
        '-crf', String(crf),
        '-preset', speed,
        '-x265-params', 'log-level=error',
        outputPath,
      ];

    /* ── CPU SVT-AV1 ──────────────────────────────────── */
    case 'libsvtav1':
      return [...pre,
        '-i', inputPath,
        ...post,
        '-c:v', 'libsvtav1',
        '-crf', String(crf),
        '-preset', speed === 'fast' ? '10' : speed === 'quality' ? '4' : '7',
        '-svtav1-params', 'tune=0',
        outputPath,
      ];

    /* ── CPU libaom-av1 ───────────────────────────────── */
    case 'libaom-av1':
      return [...pre,
        '-i', inputPath,
        ...post,
        '-c:v', 'libaom-av1',
        '-crf', String(crf),
        '-b:v', '0',
        '-cpu-used', speed === 'fast' ? '8' : speed === 'quality' ? '3' : '5',
        '-row-mt', '1',
        outputPath,
      ];

    default:
      throw new Error(`Unknown encoder: ${preset.encoder}`);
  }
}

/* ── Duration parser for ffmpeg progress ─────────────────── */
function parseDuration(str) {
  if (!str) return 0;
  // Match HH:MM:SS.fraction (ffmpeg uses 6-digit microsecond precision)
  const m = str.match(/(\d+):(\d+):([\d.]+)/);
  if (!m) return parseFloat(str) || 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
}

/* ── Run a single encode job ─────────────────────────────── */
async function runEncodeJob(jobId, resolvedPreset, deviceKey) {
  console.log(`[encode] ▶ Starting job #${jobId} on device=${deviceKey}`);
  // Load job from DB
  const [[job]] = await pool.query('SELECT * FROM encode_jobs WHERE id = ?', [jobId]);
  if (!job) {
    console.error(`[encode] ✕ Job #${jobId} not found in DB`);
    releaseSlot(jobId, deviceKey);
    return;
  }

  // Load media for duration
  const [[media]] = await pool.query('SELECT duration, file_path, size FROM media WHERE id = ?', [job.media_id]);
  if (!media) {
    console.error(`[encode] ✕ Job #${jobId}: media id=${job.media_id} not found in DB`);
    await pool.query("UPDATE encode_jobs SET status='error', error='Media not found', finished_at=NOW() WHERE id=?", [jobId]);
    emit({ type: 'job_error', jobId, error: 'Media not found' });
    releaseSlot(jobId, deviceKey);
    return;
  }

  const totalDuration = media.duration || 0;
  const inputPath = media.file_path;
  const ext = job.target_codec === 'av1' ? '.mkv' : '.mp4';
  const outputPath = path.join(ENCODE_DIR, `encode_${jobId}${ext}`);

  // Use resolved preset (passed from processQueue) or look it up
  let preset = resolvedPreset;
  if (!preset) {
    const caps = await gpuDetect.detectAll();
    preset = caps.presets.find(p => p.id === job.preset_id) || caps.presets.find(p => p.encoder === job.encoder);
  }
  if (!preset) {
    console.error(`[encode] ✕ Job #${jobId}: preset "${job.preset_id}" / encoder "${job.encoder}" not found`);
    await pool.query("UPDATE encode_jobs SET status='error', error='Preset not found', finished_at=NOW() WHERE id=?", [jobId]);
    emit({ type: 'job_error', jobId, error: 'Preset not found' });
    releaseSlot(jobId, deviceKey);
    return;
  }

  // Update status
  await pool.query("UPDATE encode_jobs SET status='encoding', started_at=NOW(), output_path=? WHERE id=?", [outputPath, jobId]);
  emit({ type: 'job_started', jobId, mediaId: job.media_id });

  return new Promise((resolve) => {
    let lastProgress = 0;
    const args = buildFfmpegArgs(inputPath, outputPath, preset, job.quality || 'balanced');
    console.log(`[encode] Job #${jobId}: ffmpeg ${args.join(' ')}`);
    console.log(`[encode] Job #${jobId}: input=${inputPath} output=${outputPath} encoder=${preset.encoder} quality=${job.quality} duration=${totalDuration}s`);
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    _activeJobs.set(jobId, { process: proc, cancelled: false, deviceKey });

    let stderrBuf = '';
    let lastSpeed = '';

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      let blockPct = -1;
      for (const line of lines) {
        // Collect speed (appears after out_time in each progress block)
        const sp = line.match(/speed=\s*(\S+)/);
        if (sp) lastSpeed = sp[1];

        const m = line.match(/out_time=(\S+)/);
        if (m && totalDuration > 0) {
          const current = parseDuration(m[1]);
          blockPct = Math.min(99, Math.round((current / totalDuration) * 100));
        }
      }
      // Emit once per data chunk with latest speed
      if (blockPct > lastProgress) {
        lastProgress = blockPct;
        pool.query("UPDATE encode_jobs SET progress=? WHERE id=?", [blockPct, jobId]).catch(() => {});
        emit({ type: 'job_progress', jobId, progress: blockPct, speed: lastSpeed, mediaId: job.media_id });
      }
    });

    proc.stderr.on('data', (data) => {
      stderrBuf += data.toString();
      // Keep only last 4KB of stderr
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    });

    proc.on('close', async (code) => {
      const jobState = _activeJobs.get(jobId);
      _activeJobs.delete(jobId);
      console.log(`[encode] Job #${jobId}: ffmpeg exited with code ${code}`);

      if (jobState?.cancelled) {
        console.log(`[encode] Job #${jobId}: cancelled by user`);
        await pool.query("UPDATE encode_jobs SET status='cancelled', finished_at=NOW() WHERE id=?", [jobId]);
        try { fs.unlinkSync(outputPath); } catch {}
        emit({ type: 'job_cancelled', jobId });
        releaseSlot(jobId, deviceKey);
        resolve();
        return;
      }

      if (code !== 0) {
        const errMsg = stderrBuf.split('\n').filter(l => l.trim()).slice(-3).join(' ').slice(0, 500);
        console.error(`[encode] ✕ Job #${jobId} FAILED (exit code ${code})`);
        console.error(`[encode]   stderr (last lines): ${errMsg}`);
        console.error(`[encode]   full stderr buffer:\n${stderrBuf}`);
        await pool.query("UPDATE encode_jobs SET status='error', error=?, finished_at=NOW() WHERE id=?", [errMsg, jobId]);
        try { fs.unlinkSync(outputPath); } catch {}
        emit({ type: 'job_error', jobId, error: errMsg });
        releaseSlot(jobId, deviceKey);
        resolve();
        return;
      }

      // Success — get output file size
      let outputSize = 0;
      try { outputSize = fs.statSync(outputPath).size; } catch {}

      const ratio = media.size ? ((1 - outputSize / media.size) * 100).toFixed(1) : '?';
      console.log(`[encode] ✓ Job #${jobId} done — ${(media.size/1e6).toFixed(1)} Mo → ${(outputSize/1e6).toFixed(1)} Mo (${ratio}% saved)`);

      await pool.query(
        "UPDATE encode_jobs SET status='done', progress=100, file_size_after=?, finished_at=NOW() WHERE id=?",
        [outputSize, jobId]
      );

      emit({ type: 'job_done', jobId, mediaId: job.media_id, outputSize, inputSize: media.size });

      // If replace_original is set, swap files
      if (job.replace_original) {
        console.log(`[encode] Job #${jobId}: replacing original file…`);
        try {
          await replaceOriginal(job.media_id, inputPath, outputPath, job.target_codec);
          console.log(`[encode] Job #${jobId}: original replaced successfully`);
        } catch (e) {
          console.error(`[encode] ✕ Job #${jobId}: failed to replace original: ${e.message}`);
          emit({ type: 'job_replace_error', jobId, error: e.message });
        }
      }

      releaseSlot(jobId, deviceKey);
      resolve();
    });
  });
}

/**
 * Replace the original file with the encoded version.
 * Updates the DB media record with new codec/size info.
 */
async function replaceOriginal(mediaId, originalPath, encodedPath, targetCodec) {
  const ext = path.extname(encodedPath);
  const dir = path.dirname(originalPath);
  const base = path.basename(originalPath, path.extname(originalPath));
  const newPath = path.join(dir, base + ext);

  // Backup original
  const backupPath = originalPath + '.bak';
  await fs.promises.rename(originalPath, backupPath);

  try {
    // Move encoded file to original location
    await fs.promises.rename(encodedPath, newPath);
    // Update DB
    const size = (await fs.promises.stat(newPath)).size;
    const codec = targetCodec === 'av1' ? 'av1' : 'hevc';
    await pool.query(
      'UPDATE media SET file_path=?, filename=?, size=?, codec=? WHERE id=?',
      [newPath, path.basename(newPath), size, codec, mediaId]
    );
    // Remove backup
    await fs.promises.unlink(backupPath);
  } catch (e) {
    // Rollback — restore original
    try { await fs.promises.rename(backupPath, originalPath); } catch {}
    throw e;
  }
}

/* ── Queue processor (device-aware) ──────────────────────── */
let _queueRunning = false;

async function processQueue() {
  // Prevent concurrent processQueue calls
  if (_queueRunning) return;
  _queueRunning = true;

  try {
    if (_running >= _maxWorkers) return;

    // Get all pending jobs
    const [pendingJobs] = await pool.query(
      "SELECT id, preset_id, encoder FROM encode_jobs WHERE status='pending' ORDER BY created_at ASC"
    );
    if (!pendingJobs.length) return;

    const caps = await gpuDetect.detectAll();

    for (const job of pendingJobs) {
      if (_running >= _maxWorkers) break;
      if (_dispatchedJobs.has(job.id)) continue;

      // Resolve preset (handles group presets like nvidia_h265 → best available GPU)
      const resolved = await resolvePreset(job.preset_id, caps);
      if (!resolved) {
        console.log(`[encode] Queue: job #${job.id} preset "${job.preset_id}" — no available device, skipping`);
        continue;
      }

      // Check device capacity
      const deviceKey = getDeviceKey(resolved);
      if (!isDeviceAvailable(resolved)) {
        console.log(`[encode] Queue: job #${job.id} device ${deviceKey} busy, skipping`);
        continue;
      }

      // Dispatch
      _dispatchedJobs.add(job.id);
      acquireDevice(deviceKey);
      _running++;

      // Update job if group preset was resolved to a specific one
      if (resolved.id !== job.preset_id) {
        await pool.query(
          "UPDATE encode_jobs SET encoder=?, preset_id=? WHERE id=?",
          [resolved.encoder, resolved.id, job.id]
        );
      }

      console.log(`[encode] Queue: dispatching job #${job.id} on ${deviceKey} (workers: ${_running}/${_maxWorkers})`);

      runEncodeJob(job.id, resolved, deviceKey).catch(e => {
        console.error(`[encode] ✕ Job #${job.id} unhandled error:`, e.message, e.stack);
        releaseSlot(job.id, deviceKey);
      });
    }
  } catch (e) {
    console.error('[encode] processQueue error:', e.message);
  } finally {
    _queueRunning = false;
  }
}

/* ── Public API ──────────────────────────────────────────── */

/**
 * Enqueue one or more media items for encoding.
 * Supports group presets (e.g., "nvidia_h265") which auto-distribute across GPUs.
 * @param {number[]} mediaIds
 * @param {object} options - { presetId, quality, replaceOriginal }
 * @returns {Promise<number[]>} created job IDs
 */
async function enqueueJobs(mediaIds, { presetId, quality = 'balanced', replaceOriginal = true } = {}) {
  console.log(`[encode] Enqueue request: ${mediaIds.length} media(s), preset=${presetId}, quality=${quality}, replace=${replaceOriginal}`);
  const caps = await gpuDetect.detectAll();
  const preset = caps.presets.find(p => p.id === presetId);
  if (!preset) {
    console.error(`[encode] ✕ Unknown preset "${presetId}". Available: ${caps.presets.map(p => p.id).join(', ')}`);
    throw new Error(`Unknown preset: ${presetId}`);
  }

  const jobIds = [];

  for (const mediaId of mediaIds) {
    // Skip if already encoding or pending for this media
    const [[existing]] = await pool.query(
      "SELECT id FROM encode_jobs WHERE media_id=? AND status IN ('pending','encoding') LIMIT 1",
      [mediaId]
    );
    if (existing) continue;

    // Get original file size
    const [[media]] = await pool.query('SELECT size FROM media WHERE id=?', [mediaId]);
    if (!media) continue;

    const [result] = await pool.query(
      `INSERT INTO encode_jobs (media_id, target_codec, encoder, preset_id, quality, replace_original, file_size_before, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [mediaId, preset.codec, preset.encoder, presetId, quality, replaceOriginal ? 1 : 0, media.size || 0]
    );
    jobIds.push(result.insertId);
  }

  // Kick the queue
  processQueue();

  return jobIds;
}

/**
 * Cancel a job (kill the ffmpeg process if running, or remove from queue).
 */
async function cancelJob(jobId) {
  console.log(`[encode] Cancelling job #${jobId}`);
  const active = _activeJobs.get(jobId);
  if (active) {
    active.cancelled = true;
    try { active.process.kill('SIGTERM'); } catch {}
    console.log(`[encode] Job #${jobId}: SIGTERM sent to ffmpeg pid=${active.process.pid}`);
  } else {
    await pool.query("UPDATE encode_jobs SET status='cancelled', finished_at=NOW() WHERE id=? AND status='pending'", [jobId]);
    console.log(`[encode] Job #${jobId}: marked cancelled (was pending)`);
  }
  emit({ type: 'job_cancelled', jobId });
}

/**
 * Cancel all pending/encoding jobs.
 */
async function cancelAll() {
  // Kill active processes
  for (const [jobId, state] of _activeJobs) {
    state.cancelled = true;
    try { state.process.kill('SIGTERM'); } catch {}
  }
  // Cancel all pending
  await pool.query("UPDATE encode_jobs SET status='cancelled', finished_at=NOW() WHERE status IN ('pending','encoding')");
  // Clear dispatched set for pending jobs that hadn't started yet
  _dispatchedJobs.clear();
  emit({ type: 'all_cancelled' });
}

/**
 * Get queue status.
 */
async function getQueueStatus() {
  const [[{ pending }]] = await pool.query("SELECT COUNT(*) as pending FROM encode_jobs WHERE status='pending'");
  const [[{ encoding }]] = await pool.query("SELECT COUNT(*) as encoding FROM encode_jobs WHERE status='encoding'");
  const [[{ done }]] = await pool.query("SELECT COUNT(*) as done FROM encode_jobs WHERE status='done'");
  const [[{ errored }]] = await pool.query("SELECT COUNT(*) as errored FROM encode_jobs WHERE status='error'");

  // Get active job details
  const [activeJobs] = await pool.query(
    `SELECT ej.*, m.file_path, m.filename, p.name as performer_name
     FROM encode_jobs ej
     JOIN media m ON m.id = ej.media_id
     JOIN performers p ON p.id = m.performer_id
     WHERE ej.status IN ('pending','encoding')
     ORDER BY ej.status DESC, ej.created_at ASC`
  );

  return { pending, encoding, done, errored, activeJobs, maxWorkers: _maxWorkers, running: _running };
}

/**
 * Get job history with pagination.
 */
async function getJobHistory(page = 1, limit = 50) {
  const offset = (page - 1) * limit;
  const [[{ total }]] = await pool.query("SELECT COUNT(*) as total FROM encode_jobs");
  const [rows] = await pool.query(
    `SELECT ej.*, m.file_path, m.filename, p.name as performer_name
     FROM encode_jobs ej
     JOIN media m ON m.id = ej.media_id
     JOIN performers p ON p.id = m.performer_id
     ORDER BY ej.created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return { data: rows, total, page, limit };
}

/**
 * Retry a failed/cancelled job.
 */
async function retryJob(jobId) {
  await pool.query(
    "UPDATE encode_jobs SET status='pending', progress=0, error=NULL, started_at=NULL, finished_at=NULL WHERE id=? AND status IN ('error','cancelled')",
    [jobId]
  );
  processQueue();
}

/**
 * Delete a job record (and its output file if exists).
 */
async function deleteJob(jobId) {
  const [[job]] = await pool.query('SELECT output_path, status FROM encode_jobs WHERE id=?', [jobId]);
  if (!job) return;
  if (job.status === 'encoding') {
    await cancelJob(jobId);
  }
  if (job.output_path) {
    try { await fs.promises.unlink(job.output_path); } catch {}
  }
  await pool.query('DELETE FROM encode_jobs WHERE id=?', [jobId]);
}

/**
 * Set max concurrent workers.
 */
function setMaxWorkers(n) {
  _maxWorkers = Math.max(1, Math.min(16, n));
  // Try to fill new slots
  processQueue();
}

function getMaxWorkers() { return _maxWorkers; }

module.exports = {
  enqueueJobs,
  cancelJob,
  cancelAll,
  getQueueStatus,
  getJobHistory,
  retryJob,
  deleteJob,
  setMaxWorkers,
  getMaxWorkers,
  subscribe,
  processQueue,
  ENCODE_DIR,
};
