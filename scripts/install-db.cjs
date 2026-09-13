'use strict';

// Run as xflix, after a completed backup and with the service stopped.
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  if (process.getuid() === 0) throw new Error('Root database bootstrap is forbidden');
  const credentials = JSON.parse(fs.readFileSync(0, 'utf8'));
  const env = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '..', '.env')));
  Object.assign(process.env, env);
  process.env.THUMB_DIR = '/opt/xflix/data/thumbs';
  const { pool, initSchema } = require('../db');
  try {
    await initSchema();
    if (!credentials.ADMIN_EMAIL && !credentials.ADMIN_PASS) return;
    if (typeof credentials.ADMIN_EMAIL !== 'string' || typeof credentials.ADMIN_PASS !== 'string' || !credentials.ADMIN_PASS) throw new Error('Invalid credentials');
    const [[existing]] = await pool.query('SELECT id FROM users WHERE email = ? OR username = ?', [credentials.ADMIN_EMAIL, 'admin']);
    if (!existing) {
      const hash = await require('bcryptjs').hash(credentials.ADMIN_PASS, 12);
      await pool.query('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)', ['admin', credentials.ADMIN_EMAIL, hash, 'admin']);
    }
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(() => {
  console.error('Database bootstrap failed; details withheld to protect credentials. Service must remain stopped.');
  process.exitCode = 1;
});
