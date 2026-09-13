'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xflix-scanner-test-'));
process.env.THUMB_DIR = path.join(tempDir, 'thumbs');
process.env.MEDIA_DIR = tempDir;
process.env.DB_PASS = 'test-only-db-password';
const { getVideoMeta, generateVideoThumb } = require('../scanner');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('native ffprobe metadata and ffmpeg thumbnail generation work end-to-end', async t => {
  if (['ffmpeg', 'ffprobe'].some(binary => spawnSync(binary, ['-version']).error?.code === 'ENOENT')) {
    t.skip('ffmpeg/ffprobe not installed');
    return;
  }
  const video = path.join(tempDir, 'sample.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video,
  ], { timeout: 30_000 });

  const metadata = await getVideoMeta(video);
  assert.equal(metadata.codec, 'h264');
  assert.equal(metadata.width, 160);
  assert.equal(metadata.height, 90);
  assert.ok(metadata.duration >= 0.9);

  const thumbnail = await generateVideoThumb(video, 999001);
  assert.ok(thumbnail);
  assert.equal(fs.existsSync(thumbnail), true);
  assert.ok(fs.statSync(thumbnail).size > 0);
});
