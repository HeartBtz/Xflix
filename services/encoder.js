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
const _listeners = new Set(); // Set<(event) => void>
const _activeJobs = new Map(); // jobId → { process, cancelled }

// Max concurrent encode workers — auto-tuned later
let _maxWorkers = 2;
let _running = 0;

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
 */
function buildFfmpegArgs(inputPath, outputPath, preset, quality = 'balanced') {
  // Quality presets: fast (lower quality), balanced, quality (slow)
  const crf = quality === 'fast' ? 32 : quality === 'quality' ? 22 : 28;
  const speed = quality === 'fast' ? 'fast' : quality === 'quality' ? 'slow' : 'medium';

  const base = [
    '-hide_banner', '-y',
    '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a?',   // first video + all audio
    '-c:a', 'copy',                       // copy audio
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-stats_period', '0.5',
  ];

  switch (preset.encoder) {
    /* ── NVIDIA NVENC ─────────────────────────────────── */
    case 'hevc_nvenc':
      return [...base,
        '-c:v', 'hevc_nvenc',
        '-gpu', String(preset.gpuIndex ?? 0),
        '-preset', speed === 'slow' ? 'p7' : speed === 'fast' ? 'p1' : 'p4',
        '-rc', 'constqp', '-qp', String(crf - 3), // NVENC uses QP, lower = better
        '-b:v', '0',
        outputPath,
      ];

    case 'av1_nvenc':
      return [...base,
        '-c:v', 'av1_nvenc',
        '-gpu', String(preset.gpuIndex ?? 0),
        '-preset', speed === 'slow' ? 'p7' : speed === 'fast' ? 'p1' : 'p4',
        '-rc', 'constqp', '-qp', String(crf - 1),
        '-b:v', '0',
        outputPath,
      ];

    /* ── VA-API (AMD / Intel) ─────────────────────────── */
    case 'hevc_vaapi':
      return [...base,
        '-vaapi_device', preset.renderDevice || '/dev/dri/renderD128',
        '-vf', 'format=nv12,hwupload',
        '-c:v', 'hevc_vaapi',
        '-qp', String(crf),
        outputPath,
      ];

    case 'av1_vaapi':
      return [...base,
        '-vaapi_device', preset.renderDevice || '/dev/dri/renderD128',
        '-vf', 'format=nv12,hwupload',
        '-c:v', 'av1_vaapi',
        '-qp', String(crf),
        outputPath,
      ];

    /* ── Intel QSV ────────────────────────────────────── */
    case 'hevc_qsv':
      return [...base,
        '-c:v', 'hevc_qsv',
        '-global_quality', String(crf),
        '-preset', speed === 'slow' ? 'veryslow' : speed === 'fast' ? 'veryfast' : 'medium',
        outputPath,
      ];

    case 'av1_qsv':
      return [...base,
        '-c:v', 'av1_qsv',
        '-global_quality', String(crf),
        outputPath,
      ];

    /* ── CPU libx265 ──────────────────────────────────── */
    case 'libx265':
      return [...base,
        '-c:v', 'libx265',
        '-crf', String(crf),
        '-preset', speed,
        '-x265-params', 'log-level=error',
        outputPath,
      ];

    /* ── CPU SVT-AV1 ──────────────────────────────────── */
    case 'libsvtav1':
      return [...base,
        '-c:v', 'libsvtav1',
        '-crf', String(crf),
        '-preset', speed === 'fast' ? '10' : speed === 'quality' ? '4' : '7',
        '-svtav1-params', 'tune=0',
        outputPath,
      ];

    /* ── CPU libaom-av1 ───────────────────────────────── */
    case 'libaom-av1':
      return [...base,
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
  const m = str.match(/(\d+):(\d+):(\d+)\.(\d+)/);
  if (!m) return parseFloat(str) || 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
}

/* ── Run a single encode job ─────────────────────────────── */
async function runEncodeJob(jobId) {
  console.log(`[encode] ▶ Starting job #${jobId}`);
  // Load job from DB
  const [[job]] = await pool.query('SELECT * FROM encode_jobs WHERE id = ?', [jobId]);
  if (!job) { console.error(`[encode] ✕ Job #${jobId} not found in DB`); return; }

  // Load media for duration
  const [[media]] = await pool.query('SELECT duration, file_path, size FROM media WHERE id = ?', [job.media_id]);
  if (!media) {
    console.error(`[encode] ✕ Job #${jobId}: media id=${job.media_id} not found in DB`);
    await pool.query("UPDATE encode_jobs SET status='error', error='Media not found', finished_at=NOW() WHERE id=?", [jobId]);
    emit({ type: 'job_error', jobId, error: 'Media not found' });
    return;
  }

  const totalDuration = media.duration || 0;
  const inputPath = media.file_path;
  const ext = job.target_codec === 'av1' ? '.mkv' : '.mp4';
  const outputPath = path.join(ENCODE_DIR, `encode_${jobId}${ext}`);

  // Get preset info
  const caps = await gpuDetect.detectAll();
  const preset = caps.presets.find(p => p.id === job.preset_id) || caps.presets.find(p => p.encoder === job.encoder);
  if (!preset) {
    console.error(`[encode] ✕ Job #${jobId}: preset "${job.preset_id}" / encoder "${job.encoder}" not found. Available presets: ${caps.presets.map(p => p.id).join(', ')}`);
    await pool.query("UPDATE encode_jobs SET status='error', error='Preset not found', finished_at=NOW() WHERE id=?", [jobId]);
    emit({ type: 'job_error', jobId, error: 'Preset not found' });
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

    _activeJobs.set(jobId, { process: proc, cancelled: false });

    let stderrBuf = '';

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const m = line.match(/out_time=(\S+)/);
        if (m && totalDuration > 0) {
          const current = parseDuration(m[1]);
          const pct = Math.min(99, Math.round((current / totalDuration) * 100));
          if (pct > lastProgress) {
            lastProgress = pct;
            pool.query("UPDATE encode_jobs SET progress=? WHERE id=?", [pct, jobId]).catch(() => {});
            emit({ type: 'job_progress', jobId, progress: pct, mediaId: job.media_id });
          }
        }
        // Speed info
        const sp = line.match(/speed=\s*(\S+)/);
        if (sp) {
          emit({ type: 'job_speed', jobId, speed: sp[1] });
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderrBuf += data.toString();
      // Keep only last 4KB of stderr
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    });

    proc.on('close', async (code) => {
      _activeJobs.delete(jobId);
      _running--;
      console.log(`[encode] Job #${jobId}: ffmpeg exited with code ${code}`);

      const jobState = _activeJobs.get(jobId);
      if (jobState?.cancelled) {
        // Was cancelled
        console.log(`[encode] Job #${jobId}: cancelled by user`);
        await pool.query("UPDATE encode_jobs SET status='cancelled', finished_at=NOW() WHERE id=?", [jobId]);
        try { fs.unlinkSync(outputPath); } catch {}
        emit({ type: 'job_cancelled', jobId });
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

      resolve();
      // Trigger next job
      processQueue();
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

/* ── Queue processor ─────────────────────────────────────── */
async function processQueue() {
  if (_running >= _maxWorkers) {
    console.log(`[encode] Queue: max workers reached (${_running}/${_maxWorkers}), waiting…`);
    return;
  }

  // Get next pending job
  const [[nextJob]] = await pool.query(
    "SELECT id FROM encode_jobs WHERE status='pending' ORDER BY created_at ASC LIMIT 1"
  );
  if (!nextJob) return;

  console.log(`[encode] Queue: dispatching job #${nextJob.id} (workers: ${_running + 1}/${_maxWorkers})`);
  _running++;
  runEncodeJob(nextJob.id).catch(e => {
    console.error(`[encode] ✕ Job #${nextJob.id} unhandled error:`, e.message, e.stack);
    _running--;
  });

  // Check if we can run more
  if (_running < _maxWorkers) {
    setImmediate(processQueue);
  }
}

/* ── Public API ──────────────────────────────────────────── */

/**
 * Enqueue one or more media items for encoding.
 * @param {number[]} mediaIds
 * @param {object} options - { presetId, quality, replaceOriginal }
 * @returns {Promise<number[]>} created job IDs
 */
async function enqueueJobs(mediaIds, { presetId, quality = 'balanced', replaceOriginal = false } = {}) {
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
