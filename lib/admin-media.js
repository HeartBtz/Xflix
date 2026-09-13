'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { resolveInside } = require('./media-files');
const { withMaintenance } = require('./maintenance');
const { MEDIA_DIR, THUMB_DIR } = require('../scanner');
const MAX_IDS = 500;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function idsInput(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS ||
      ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw fail('ids must contain 1 to 500 distinct positive integers');
  }
  return ids;
}

function booleanInput(body, key, fallback) {
  const value = body?.[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw fail(`${key} must be a boolean`);
  return value;
}

async function destructivePath(root, target, { allowMissing = false } = {}) {
  if (typeof target !== 'string' || !target || target.includes('\0') || target.split(path.sep).includes('..')) {
    throw fail('Invalid destructive path', 403);
  }
  const lexicalRoot = path.resolve(root);
  const canonicalRoot = await fs.promises.realpath(lexicalRoot);
  const absolute = path.resolve(lexicalRoot, target);
  let relative = path.relative(lexicalRoot, absolute);
  const outside = value => value === '..' || value.startsWith(`..${path.sep}`) || path.isAbsolute(value);
  if (outside(relative)) relative = path.relative(canonicalRoot, absolute);
  if (outside(relative)) throw fail('Path is outside the storage root', 403);
  let current = canonicalRoot;
  // Only the configured root may be an alias. Inspect each original component
  // before resolveInside can erase evidence of a symlink to another live file.
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = await fs.promises.lstat(current); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw fail('Symlinks below the storage root cannot be used for destructive operations', 403);
  }
  const resolved = await resolveInside(root, target, { allowMissing });
  if (resolved !== path.resolve(canonicalRoot, relative)) throw fail('Path changed during validation', 409);
  return resolved;
}

async function mediaPath(target, allowMissing = false, destructive = false) {
  const resolved = destructive
    ? await destructivePath(MEDIA_DIR, target, { allowMissing })
    : await resolveInside(MEDIA_DIR, target, { allowMissing });
  const root = await fs.promises.realpath(MEDIA_DIR);
  if (path.relative(root, resolved).split(path.sep)[0] === '.xflix-trash') {
    throw fail('Quarantined files are not live media', 403);
  }
  return resolved;
}

async function storageReady({ missing = false } = {}) {
  const root = await fs.promises.realpath(MEDIA_DIR);
  const st = await fs.promises.stat(root);
  if (!st.isDirectory()) throw fail('Media storage unavailable', 503);
  await fs.promises.readdir(root);
  const sentinel = process.env.XFLIX_STORAGE_SENTINEL;
  const expected = process.env.XFLIX_STORAGE_SENTINEL_VALUE;
  if (missing && (process.env.XFLIX_ALLOW_MISSING_CLEANUP !== 'true' || !sentinel || !expected)) {
    throw fail('Missing-file cleanup requires explicit opt-in and a storage sentinel', 503);
  }
  if (sentinel || expected) {
    if (!sentinel || !expected) throw fail('Incomplete storage sentinel configuration', 503);
    const file = await mediaPath(path.resolve(root, sentinel));
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.dev !== st.dev || info.size > 4096 || (await handle.readFile('utf8')).trim() !== expected) {
        throw fail('Storage sentinel mismatch', 503);
      }
    } finally { await handle.close(); }
  }
  return { root, dev: st.dev, ino: st.ino };
}

async function isMissing(target) {
  const file = await mediaPath(target, true);
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) throw fail('Media path is not a regular file', 409);
    return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return true;
  }
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function hashFile(target, { trash = false, cancelled = () => false } = {}) {
  const file = trash ? await resolveInside(MEDIA_DIR, target) : await mediaPath(target);
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw fail('Not a regular media file', 409);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (true) {
      if (cancelled()) throw fail('Operation cancelled', 409);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (total !== before.size || !sameFile(before, after) ||
        !sameFile(after, await fs.promises.stat(file))) throw fail('File changed during verification', 409);
    return { path: file, hash: hash.digest('hex'), stat: after };
  } finally { await handle.close(); }
}

async function journalLine(file, data) {
  const handle = await fs.promises.open(file, fs.constants.O_WRONLY | fs.constants.O_APPEND |
    fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(data)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

async function syncDir(dir) {
  const handle = await fs.promises.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// The SQL journal is committed with the delete; the fsynced disk journal also
// covers crashes between rename and COMMIT. Neither journal is auto-purged.
async function removeMedia({ ids, deleteFile, duplicate = false, missing = false, maxDuration,
  actorId, cancelled = () => false, progress = () => {} }) {
  idsInput(ids);
  if (typeof deleteFile !== 'boolean') throw fail('deleteFile must be a boolean');
  if (process.env.XFLIX_MEDIA_WRITE !== 'true') {
    throw fail('Media maintenance is read-only. XFLIX_MEDIA_WRITE=true and a writable service sandbox are required for quarantine.', 403);
  }
  return withMaintenance(async () => {
    const storage = await storageReady({ missing });
    const trashBase = path.join(storage.root, '.xflix-trash');
    await destructivePath(MEDIA_DIR, trashBase, { allowMissing: true });
    try { await fs.promises.mkdir(trashBase, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if ((await fs.promises.lstat(trashBase)).isSymbolicLink()) throw fail('Trash must not be a symlink', 403);
    const trash = await destructivePath(MEDIA_DIR, trashBase);
    await syncDir(storage.root);
    const operationId = crypto.randomUUID();
    const directory = path.join(trash, operationId);
    await fs.promises.mkdir(directory, { mode: 0o700 });
    await syncDir(trash);
    const journal = path.join(directory, 'journal.jsonl');
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_media_journal (
      operation_id CHAR(36) PRIMARY KEY, actor_id INT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, payload LONGTEXT NOT NULL
    ) ENGINE=InnoDB`);
    const conn = await pool.getConnection();
    const moves = [];
    let committed = false;
    let commitAttempted = false;
    let rollbackFailed = false;
    let uncertainMove = false;
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM media WHERE id IN (?) ORDER BY id FOR UPDATE', [ids]);
      if (rows.length !== ids.length) throw fail('One or more media no longer exist', 404);
      const snapshot = { version: 1, operation_id: operationId, actor_id: actorId,
        reason: duplicate ? 'duplicate' : missing ? 'missing' : maxDuration ? 'short-video' : 'manual',
        delete_file: deleteFile, media: rows, moves, related: {} };
      for (const table of ['comments', 'media_reactions', 'user_favorites', 'media_tags']) {
        [snapshot.related[table]] = await conn.query(`SELECT * FROM ${table} WHERE media_id IN (?) FOR UPDATE`, [ids]);
      }
      [snapshot.related.performers] = await conn.query('SELECT * FROM performers WHERE id IN (?) FOR UPDATE',
        [[...new Set(rows.map(row => row.performer_id))]]);
      [snapshot.related.tags] = await conn.query('SELECT t.* FROM tags t JOIN media_tags mt ON mt.tag_id = t.id WHERE mt.media_id IN (?)', [ids]);
      await journalLine(journal, { state: 'prepared', snapshot });
      await syncDir(directory);
      let done = 0;
      const survivors = new Map();
      for (const row of rows) {
        if (cancelled()) throw fail('Operation cancelled', 409);
        const currentStorage = await storageReady({ missing });
        if (currentStorage.dev !== storage.dev || currentStorage.ino !== storage.ino || currentStorage.root !== storage.root) {
          throw fail('Storage changed during operation', 503);
        }
        if (maxDuration !== undefined && (row.type !== 'video' || !(row.duration > 0 && row.duration < maxDuration))) {
          throw fail('Video no longer matches the purge threshold', 409);
        }
        const sourcePath = await mediaPath(row.file_path, missing, true);
        if (missing) {
          const parent = await destructivePath(MEDIA_DIR, path.dirname(row.file_path));
          const parentStat = await fs.promises.stat(parent);
          if (parentStat.dev !== storage.dev) throw fail('Missing media is on a different mount than the sentinel', 503);
          await fs.promises.readdir(parent);
          if (!(await isMissing(row.file_path))) throw fail('Previously missing media has returned', 409);
        } else {
          const source = await hashFile(sourcePath, { cancelled });
          let survivor;
          if (duplicate) {
            const [candidates] = await conn.query('SELECT * FROM media WHERE id NOT IN (?) AND type = ? ORDER BY id FOR UPDATE', [ids, row.type]);
            for (const candidate of candidates) {
              if (cancelled()) throw fail('Operation cancelled', 409);
              try {
                // SQL sizes may be stale, so filter by actual size before hashing.
                const candidatePath = await mediaPath(candidate.file_path, false, true);
                const st = await fs.promises.stat(candidatePath);
                if (st.size !== source.stat.size || (st.dev === source.stat.dev && st.ino === source.stat.ino)) continue;
                const check = await hashFile(candidatePath, { cancelled });
                if (check.hash === source.hash) { survivor = { ...check, target: candidate.file_path }; break; }
              } catch (error) {
                // An unrelated absent candidate is not evidence of a storage I/O
                // failure. A chosen survivor disappearing later still aborts.
                if (error.code !== 'ENOENT') throw error;
              }
            }
            if (!survivor) throw fail('No complete independent duplicate survives outside this selection', 409);
          }
          if (deleteFile) {
            const from = await mediaPath(row.file_path, false, true);
            if (!sameFile(source.stat, await fs.promises.stat(from))) throw fail('Media changed before quarantine', 409);
            const move = { id: row.id, from, to: path.join(directory, `${row.id}.media`),
              sha256: source.hash, size: source.stat.size, survivor: survivor?.path };
            await journalLine(journal, { state: 'move-intent', ...move });
            await destructivePath(MEDIA_DIR, move.to, { allowMissing: true });
            try { await fs.promises.rename(move.from, move.to); }
            catch (error) { uncertainMove = error.code === 'EIO'; throw error; }
            moves.push(move);
            await syncDir(path.dirname(move.from));
            await syncDir(directory);
            const moved = await hashFile(move.to, { trash: true, cancelled });
            if (moved.hash !== source.hash) throw fail('Quarantined file failed verification', 409);
          }
          if (survivor) {
            const verified = await hashFile(await mediaPath(survivor.target, false, true), { cancelled });
            if (verified.hash !== source.hash || !sameFile(verified.stat, survivor.stat)) {
              throw fail('Surviving duplicate changed during deletion', 409);
            }
            survivors.set(survivor.path, survivor);
          }
        }
        progress({ id: row.id, done: ++done, total: rows.length, staged: true });
      }
      if (cancelled()) throw fail('Operation cancelled', 409);
      for (const survivor of survivors.values()) {
        const verified = await hashFile(await mediaPath(survivor.target, false, true), { cancelled });
        if (verified.hash !== survivor.hash || !sameFile(verified.stat, survivor.stat)) {
          throw fail('Surviving duplicate changed before commit', 409);
        }
      }
      await conn.query('INSERT INTO admin_media_journal (operation_id, actor_id, payload) VALUES (?, ?, ?)',
        [operationId, actorId, JSON.stringify(snapshot)]);
      const [result] = await conn.query('DELETE FROM media WHERE id IN (?)', [ids]);
      if (result.affectedRows !== rows.length) throw fail('Media changed before deletion', 409);
      await conn.query(`UPDATE performers SET
        video_count = (SELECT COUNT(*) FROM media WHERE performer_id = performers.id AND type = 'video'),
        photo_count = (SELECT COUNT(*) FROM media WHERE performer_id = performers.id AND type = 'photo'),
        total_size = (SELECT COALESCE(SUM(size), 0) FROM media WHERE performer_id = performers.id),
        cover_media_id = IF(cover_media_id IN (?), NULL, cover_media_id),
        random_cover_id = IF(random_cover_id IN (?), NULL, random_cover_id)
        WHERE id IN (?)`, [ids, ids, [...new Set(rows.map(row => row.performer_id))]]);
      await journalLine(journal, { state: 'commit-intent', moves });
      commitAttempted = true;
      await conn.commit();
      committed = true;
      await journalLine(journal, { state: 'committed' });
      return { deleted: rows.length, operation_id: operationId, quarantined: moves.length };
    } catch (error) {
      if (!committed) {
        try { await conn.rollback(); } catch (_) { rollbackFailed = true; }
      }
      const compensationErrors = [];
      if (!commitAttempted && !rollbackFailed) {
        for (const move of [...moves].reverse()) {
          try {
            const destination = await mediaPath(move.from, true, true);
            // link is exclusive: never overwrite a file recreated by another process.
            // Keep the quarantine link and journal for manual recovery/audit.
            await fs.promises.link(await destructivePath(MEDIA_DIR, move.to), destination);
            await syncDir(path.dirname(destination));
          } catch (restoreError) { compensationErrors.push({ id: move.id, code: restoreError.code }); }
        }
      }
      const recoveryRequired = commitAttempted || rollbackFailed || uncertainMove || compensationErrors.length > 0;
      try { await journalLine(journal, { state: committed ? 'committed-journal-error' : recoveryRequired ? 'recovery-required' : 'rolled-back', compensationErrors }); }
      catch (_) { /* The prepared journal is retained even if this append fails. */ }
      Object.assign(error, { operation_id: operationId, deleted: committed ? ids.length : commitAttempted || rollbackFailed ? null : 0,
        recovery_required: Boolean(recoveryRequired), compensation_errors: compensationErrors });
      throw error;
    } finally { conn.release(); }
  });
}

async function quarantineThumb(target) {
  await storageReady();
  const from = await destructivePath(THUMB_DIR, target);
  const root = await fs.promises.realpath(THUMB_DIR);
  if (path.relative(root, from).split(path.sep)[0] === '.xflix-trash') throw fail('Thumbnail is already quarantined', 403);
  if (!(await fs.promises.lstat(from)).isFile()) throw fail('Orphan thumbnail must be a regular file', 409);
  const base = path.join(root, '.xflix-trash');
  await destructivePath(THUMB_DIR, base, { allowMissing: true });
  try { await fs.promises.mkdir(base, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if ((await fs.promises.lstat(base)).isSymbolicLink()) throw fail('Trash must not be a symlink', 403);
  await syncDir(path.dirname(base));
  const operationId = crypto.randomUUID();
  const directory = path.join(await destructivePath(THUMB_DIR, base), operationId);
  await fs.promises.mkdir(directory, { mode: 0o700 });
  await syncDir(base);
  const to = path.join(directory, path.basename(from));
  const journal = path.join(directory, 'journal.jsonl');
  await journalLine(journal, { state: 'thumbnail-move-intent', from, to });
  await syncDir(directory);
  let moved = false;
  try {
    if (await destructivePath(THUMB_DIR, target) !== from) throw fail('Thumbnail path changed', 409);
    await destructivePath(THUMB_DIR, to, { allowMissing: true });
    await fs.promises.rename(from, to);
    moved = true;
    await syncDir(path.dirname(from));
    await syncDir(directory);
    await journalLine(journal, { state: 'committed' });
    return operationId;
  } catch (error) {
    Object.assign(error, { operation_id: operationId, recovery_required: moved || error.code === 'EIO',
      quarantined: moved ? 1 : error.code === 'EIO' ? null : 0 });
    throw error;
  }
}

module.exports = { MAX_IDS, fail, idsInput, booleanInput, mediaPath, storageReady, isMissing, hashFile, removeMedia, quarantineThumb };
