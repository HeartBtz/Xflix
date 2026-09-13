'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveInside, writeAtomic } = require('../lib/media-files');

let temporary, root, outside;
test.before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'xflix-paths-'));
  root = path.join(temporary, 'media');
  outside = path.join(temporary, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'photo.jpg'), 'original');
  await fs.symlink(outside, path.join(root, 'escape'));
  await fs.symlink(root, path.join(temporary, 'root-alias'));
  await fs.symlink(path.join(root, 'photo.jpg'), path.join(root, 'local.jpg'));
  await fs.symlink(path.join(outside, 'missing'), path.join(root, 'dangling'));
});
test.after(async () => fs.rm(temporary, { recursive: true, force: true }));

test('canonicalizes trusted root aliases and in-root links', async () => {
  assert.equal(await resolveInside(root, 'local.jpg'), path.join(root, 'photo.jpg'));
  assert.equal(await resolveInside(path.join(temporary, 'root-alias'), 'photo.jpg'), path.join(root, 'photo.jpg'));
});

test('rejects absolute, relative, prefix-collision and symlink escapes including missing leaves', async () => {
  for (const target of [outside, '../outside/file.jpg', `${root}-other/photo.jpg`, 'escape/file.jpg', 'dangling']) {
    await assert.rejects(resolveInside(root, target, { allowMissing: true }), { code: 'EACCES' });
  }
  await assert.rejects(resolveInside(root, 'photo.jpg/child', { allowMissing: true }), { code: 'ENOTDIR' });
});

test('distinguishes ENOENT and canonicalizes missing parents without following dangling links', async () => {
  await assert.rejects(resolveInside(root, 'new/deep.jpg'), { code: 'ENOENT' });
  assert.equal(await resolveInside(root, 'new/deep.jpg', { allowMissing: true }), path.join(root, 'new/deep.jpg'));
  await fs.symlink(root, path.join(root, 'alias'));
  assert.equal(await resolveInside(root, 'alias/new/deep.jpg', { allowMissing: true }), path.join(root, 'new/deep.jpg'));
});

test('atomic writers retain old output on failure, clean staging, and publish only complete output', async () => {
  const target = path.join(root, 'photo.jpg');
  await assert.rejects(writeAtomic(root, target, async output => {
    await fs.writeFile(output, 'partial');
    assert.equal(await fs.readFile(target, 'utf8'), 'original');
    throw new Error('encoder failed');
  }), /encoder failed/);
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
  await assert.rejects(writeAtomic(root, 'empty.jpg', output => fs.writeFile(output, '')), /Empty/);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.xflix-write-')), false);
  await writeAtomic(root, target, output => fs.writeFile(output, 'complete'));
  assert.equal(await fs.readFile(target, 'utf8'), 'complete');
  let called = false;
  await assert.rejects(writeAtomic(root, 'escape/upload.jpg', async () => { called = true; }), { code: 'EACCES' });
  assert.equal(called, false);
});
