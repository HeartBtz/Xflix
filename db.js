/**
 * db.js — Database layer
 *
 * Creates the mysql2 connection pool and owns every schema migration.
 * All DB-related functions exported here are the single source of truth
 * for data access across the entire application — no raw pool.query calls
 * should live in route files for business logic (only for ad-hoc queries).
 *
 * Schema overview (simplified ER)
 * ────────────────────────────────────────────────────────────────────────────
 *   users ←── comments ──→ media ←── performers
 *   users ←── media_reactions ──→ media
 *   users ←── user_favorites  ──→ media
 *   performers ←── media  (ON DELETE CASCADE)
 *   performers ←── performer_tags
 *   tags       ←── performer_tags  (many-to-many)
 *   settings   (key/value store for SMTP + app config)
 *
 * Migrations are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
 * so initSchema() is safe to call on every boot.
 */
const mysql = require('mysql2/promise');
require('dotenv').config();

if (!process.env.DB_PASS) {
  console.error('  ❌  DB_PASS non défini dans .env — la connexion échouera.');
  console.error('  Lancez install.sh ou configurez manuellement le fichier .env.');
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'xflix',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'xflix',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  charset: 'utf8mb4',
  // Performance tweaks
  multipleStatements: false,
  dateStrings: true,          // avoid Date object overhead
  supportBigNumbers: true,
  bigNumberStrings: false,
});

async function initSchema() {
  const conn = await pool.getConnection();
  try {

    // ── Users ───────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('admin','member') DEFAULT 'member',
        avatar VARCHAR(500),
        bio TEXT,
        reset_token VARCHAR(255),
        reset_expires DATETIME,
        last_login DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        KEY idx_users_email (email),
        KEY idx_users_role (role)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── Settings (SMTP, site config) ─────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS settings (
        \`key\` VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── Performers (must exist before media) ──────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS performers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        dir_path TEXT NOT NULL,
        video_count INT DEFAULT 0,
        photo_count INT DEFAULT 0,
        total_size BIGINT DEFAULT 0,
        favorite TINYINT DEFAULT 0,
        cover_media_id INT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_performers_name (name),
        KEY idx_performers_favorite (favorite)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS media (
        id INT AUTO_INCREMENT PRIMARY KEY,
        performer_id INT NOT NULL,
        filename VARCHAR(500) NOT NULL,
        file_path VARCHAR(1000) NOT NULL,
        type ENUM('video','photo') NOT NULL,
        mime_type VARCHAR(100),
        size BIGINT DEFAULT 0,
        width INT,
        height INT,
        duration DOUBLE,
        thumb_path VARCHAR(500),
        favorite TINYINT DEFAULT 0,
        view_count INT DEFAULT 0,
        last_viewed DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY idx_file_path (file_path),
        KEY idx_performer (performer_id),
        KEY idx_type (type),
        KEY idx_size (size),
        KEY idx_favorite (favorite),
        KEY idx_view_count (view_count),
        FOREIGN KEY (performer_id) REFERENCES performers(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS tags (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS performer_tags (
        performer_id INT NOT NULL,
        tag_id INT NOT NULL,
        PRIMARY KEY (performer_id, tag_id),
        FOREIGN KEY (performer_id) REFERENCES performers(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── Comments ─────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        media_id INT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_comments_media (media_id),
        KEY idx_comments_user (user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── Reactions (like/dislike) ──────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS media_reactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        media_id INT NOT NULL,
        type ENUM('like','dislike') NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY idx_reaction_user_media (user_id, media_id),
        KEY idx_reaction_media (media_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── User Favorites ────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_favorites (
        user_id INT NOT NULL,
        media_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, media_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── Migrations : index manquants + colonnes ajoutées post-création ──────
    // Idempotent — sécurisé sur une base existante
    await conn.query(`ALTER TABLE performers ADD COLUMN IF NOT EXISTS random_cover_id INT NULL`);
    await conn.query(`ALTER TABLE performers DROP INDEX IF EXISTS idx_performers_name`);
    await conn.query(`ALTER TABLE media ADD INDEX IF NOT EXISTS idx_last_viewed (last_viewed)`);
    await conn.query(`ALTER TABLE media ADD INDEX IF NOT EXISTS idx_performer_type (performer_id, type)`);
    await conn.query(`ALTER TABLE media ADD INDEX IF NOT EXISTS idx_type_favorite (type, favorite)`);
    await conn.query(`ALTER TABLE media ADD INDEX IF NOT EXISTS idx_type_viewcount (type, view_count)`);

    // ── Video metadata columns (v1.3.0) ──────────────────────────────
    await conn.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS codec VARCHAR(50)`);
    await conn.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS audio_codec VARCHAR(50)`);
    await conn.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS bitrate INT`);
    await conn.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS fps FLOAT`);
    await conn.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS audio_sample_rate INT`);
    await conn.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS audio_channels TINYINT`);

    // ── Media tags (many-to-many: media ↔ tags) ──────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS media_tags (
        media_id INT NOT NULL,
        tag_id   INT NOT NULL,
        PRIMARY KEY (media_id, tag_id),
        FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id)   REFERENCES tags(id)  ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── Encode jobs table removed — now managed by xflix-encoder ──

  } finally {
    conn.release();
  }
}

async function clearAll() {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  await pool.query('TRUNCATE TABLE media_tags');
  await pool.query('TRUNCATE TABLE performer_tags');
  await pool.query('TRUNCATE TABLE tags');
  await pool.query('TRUNCATE TABLE media');
  await pool.query('TRUNCATE TABLE performers');
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
}

/* ── Tag helpers ───────────────────────────────────────────────── */

/**
 * Get or create a tag by name, returning its id.
 */
async function getOrCreateTag(name) {
  await pool.query('INSERT IGNORE INTO tags (name) VALUES (?)', [name]);
  const [[row]] = await pool.query('SELECT id FROM tags WHERE name = ?', [name]);
  return row.id;
}

/**
 * Replace the full tag set for a media item.
 * Deletes existing rows then bulk-inserts the new tag ids.
 */
async function setMediaTags(mediaId, tagIds) {
  if (!tagIds.length) return;
  await pool.query('DELETE FROM media_tags WHERE media_id = ?', [mediaId]);
  const values = tagIds.map(id => [mediaId, id]);
  await pool.query('INSERT IGNORE INTO media_tags (media_id, tag_id) VALUES ?', [values]);
}

/**
 * Batch-load tags for a list of media ids.
 * Returns Map<mediaId, string[]>.
 */
async function getTagsForMediaBatch(mediaIds) {
  if (!mediaIds.length) return new Map();
  const [rows] = await pool.query(
    'SELECT mt.media_id, t.name FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id IN (?)',
    [mediaIds]
  );
  const map = new Map();
  for (const { media_id, name } of rows) {
    if (!map.has(media_id)) map.set(media_id, []);
    map.get(media_id).push(name);
  }
  return map;
}

async function upsertPerformer(name, dirPath) {
  // One round-trip: INSERT … ON DUPLICATE KEY UPDATE sets LAST_INSERT_ID to the existing id
  const [result] = await pool.query(
    'INSERT INTO performers (name, dir_path) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
    [name, dirPath]
  );
  return result.insertId;
}

/**
 * Returns a Map of file_path → media_id for one performer.
 */
async function getExistingFilePaths(performerId) {
  const [rows] = await pool.query(
    'SELECT id, file_path FROM media WHERE performer_id = ?',
    [performerId]
  );
  const map = new Map();
  for (const r of rows) map.set(r.file_path, r.id);
  return map;
}

/**
 * Bulk-load ALL existing file paths across all performers in one query.
 * Returns Map<performerId, Set<filePath>> — used by scanner to avoid 26 roundtrips.
 */
async function getAllExistingFilePaths() {
  const [rows] = await pool.query('SELECT performer_id, file_path FROM media');
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.performer_id)) map.set(r.performer_id, new Set());
    map.get(r.performer_id).add(r.file_path);
  }
  return map;
}

async function insertMedia(performerId, filename, filePath, type, mimeType, size, width, height, duration) {
  try {
    await pool.query(
      `INSERT IGNORE INTO media (performer_id, filename, file_path, type, mime_type, size, width, height, duration)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [performerId, filename, filePath, type, mimeType, size, width || null, height || null, duration || null]
    );
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return; // expected — skip duplicates
    console.error('[DB] insertMedia error:', e.message);
  }
}

/**
 * Batch-insert multiple media records in a single query.
 * records: Array of [performerId, filename, filePath, type, mimeType, size, width, height, duration]
 */
async function batchInsertMedia(records) {
  if (!records.length) return;
  const placeholders = records.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
  const values = records.flat();
  try {
    await pool.query(
      `INSERT IGNORE INTO media (performer_id, filename, file_path, type, mime_type, size, width, height, duration)
       VALUES ${placeholders}`,
      values
    );
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return; // expected — skip duplicates
    console.error('[DB] batchInsertMedia error:', e.message);
  }
}

async function updatePerformerCounts() {
  await pool.query(`
    UPDATE performers SET
      video_count = (SELECT COUNT(*) FROM media WHERE performer_id = performers.id AND type = 'video'),
      photo_count = (SELECT COUNT(*) FROM media WHERE performer_id = performers.id AND type = 'photo'),
      total_size  = (SELECT COALESCE(SUM(size),0) FROM media WHERE performer_id = performers.id)
  `);
  await pool.query(`
    UPDATE performers p SET cover_media_id = (
      SELECT id FROM media WHERE performer_id = p.id AND type = 'photo' LIMIT 1
    ) WHERE p.cover_media_id IS NULL
  `);
  // Rafraîchit random_cover_id (préfère les photos) — exécuté après chaque scan,
  // évite N sous-requêtes RAND() à chaque chargement de la page d'accueil.
  await pool.query(`
    UPDATE performers p SET random_cover_id = COALESCE(
      (SELECT id FROM media WHERE performer_id = p.id AND type = 'photo' ORDER BY RAND() LIMIT 1),
      (SELECT id FROM media WHERE performer_id = p.id ORDER BY RAND() LIMIT 1)
    )
  `);
}

async function updateThumb(mediaId, thumbPath) {
  await pool.query('UPDATE media SET thumb_path = ? WHERE id = ?', [thumbPath, mediaId]);
}

async function togglePerformerFavorite(performerId) {
  await pool.query('UPDATE performers SET favorite = IF(favorite = 1, 0, 1) WHERE id = ?', [performerId]);
  const [rows] = await pool.query('SELECT favorite FROM performers WHERE id = ?', [performerId]);
  return rows[0] || null;
}

async function toggleMediaFavorite(mediaId) {
  await pool.query('UPDATE media SET favorite = IF(favorite = 1, 0, 1) WHERE id = ?', [mediaId]);
  const [rows] = await pool.query('SELECT favorite FROM media WHERE id = ?', [mediaId]);
  return rows[0] || null;
}

async function incrementViewCount(mediaId) {
  await pool.query('UPDATE media SET view_count = view_count + 1, last_viewed = NOW() WHERE id = ?', [mediaId]);
}

/* ── Settings ─────────────────────────────────────────────────── */

async function getSetting(key, defaultValue = null) {
  const [rows] = await pool.query('SELECT value FROM settings WHERE `key` = ?', [key]);
  return rows.length ? rows[0].value : defaultValue;
}

async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
    [key, value, value]
  );
}

async function getSettings(keys) {
  if (!keys.length) return {};
  const [rows] = await pool.query('SELECT `key`, value FROM settings WHERE `key` IN (?)', [keys]);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function getAllSettings() {
  const [rows] = await pool.query('SELECT `key`, value FROM settings');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/* ── Users ─────────────────────────────────────────────────────── */

async function createUser(username, email, passwordHash, role = 'member') {
  const [res] = await pool.query(
    'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
    [username, email, passwordHash, role]
  );
  return res.insertId;
}

async function getUserByEmail(email) {
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0] || null;
}

async function getUserById(id) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

async function getUserByResetToken(token) {
  const [rows] = await pool.query(
    'SELECT * FROM users WHERE reset_token = ? AND reset_expires > NOW()',
    [token]
  );
  return rows[0] || null;
}

async function setResetToken(userId, token, expires) {
  await pool.query('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?', [token, expires, userId]);
}

async function clearResetToken(userId, newHash) {
  await pool.query('UPDATE users SET reset_token = NULL, reset_expires = NULL, password_hash = ? WHERE id = ?', [newHash, userId]);
}

async function updateLastLogin(userId) {
  await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [userId]);
}

async function updateUserProfile(userId, { username, bio, avatar } = {}) {
  const parts = [];
  const params = [];
  if (username !== undefined) { parts.push('username = ?'); params.push(username); }
  if (bio      !== undefined) { parts.push('bio = ?');      params.push(bio); }
  if (avatar   !== undefined) { parts.push('avatar = ?');   params.push(avatar); }
  if (!parts.length) return;
  params.push(userId);
  await pool.query(`UPDATE users SET ${parts.join(', ')} WHERE id = ?`, params);
}

async function listUsers({ page = 1, limit = 50 } = {}) {
  const offset = (page - 1) * limit;
  const [[{ total }]] = await pool.query('SELECT COUNT(*) as total FROM users');
  const [rows] = await pool.query(
    'SELECT id, username, email, role, avatar, created_at, last_login FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset]
  );
  return { data: rows, total };
}

async function updateUserRole(userId, role) {
  await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
}

async function deleteUser(userId) {
  await pool.query('DELETE FROM users WHERE id = ?', [userId]);
}

async function countAdmins() {
  const [[{ cnt }]] = await pool.query("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'");
  return cnt;
}

module.exports = {
  pool, initSchema, clearAll,
  upsertPerformer, getExistingFilePaths, getAllExistingFilePaths, insertMedia, batchInsertMedia,
  updatePerformerCounts, updateThumb, togglePerformerFavorite, toggleMediaFavorite,
  incrementViewCount,
  getOrCreateTag, setMediaTags, getTagsForMediaBatch,
  getSetting, setSetting, getSettings, getAllSettings,
  createUser, getUserByEmail, getUserById, getUserByResetToken,
  setResetToken, clearResetToken, updateLastLogin, updateUserProfile,
  listUsers, updateUserRole, deleteUser, countAdmins,
};
