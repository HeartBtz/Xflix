'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function denied() {
  return Object.assign(new Error('Path is outside the media root'), { code: 'EACCES', status: 403 });
}

async function resolveInside(root, target, { allowMissing = false } = {}) {
  if (typeof target !== 'string' || !target || target.includes('\0')) throw denied();
  const lexicalRoot = path.resolve(root);
  const canonicalRoot = await fs.realpath(lexicalRoot);
  const absolute = path.resolve(lexicalRoot, target);
  const base = inside(lexicalRoot, absolute) ? lexicalRoot : canonicalRoot;
  if (!inside(base, absolute)) throw denied();
  let current = canonicalRoot;
  const components = path.relative(base, absolute).split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !allowMissing) throw error;
      return path.join(current, ...components.slice(index + 1));
    }
    // A dangling symlink is not a missing leaf that is safe to create.
    if (stat.isSymbolicLink()) {
      try { current = await fs.realpath(current); }
      catch (error) { if (error.code === 'ENOENT') throw denied(); throw error; }
      if (!inside(canonicalRoot, current)) throw denied();
    }
    if (index < components.length - 1 && !(await fs.stat(current)).isDirectory()) {
      throw Object.assign(new Error('Path parent is not a directory'), { code: 'ENOTDIR' });
    }
  }
  return current;
}

// The writer only sees a fresh private staging directory. Publish after success.
async function writeAtomic(root, target, write) {
  const destination = await resolveInside(root, target, { allowMissing: true });
  const directory = await fs.mkdtemp(path.join(path.dirname(destination), '.xflix-write-'));
  const temporary = path.join(directory, path.basename(destination));
  try {
    await write(temporary);
    const stat = await fs.lstat(temporary);
    if (!stat.isFile() || !stat.size) throw new Error('Empty or invalid generated file');
    const checked = await resolveInside(root, target, { allowMissing: true });
    if (checked !== destination) throw denied();
    await fs.rename(temporary, destination);
    return destination;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { resolveInside, writeAtomic };
