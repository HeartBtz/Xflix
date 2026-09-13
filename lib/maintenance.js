'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const { pool } = require('../db');

const context = new AsyncLocalStorage();

// The database lock also excludes maintenance started from the CLI or another process.
async function withMaintenance(operation) {
  if (context.getStore()?.active) return operation();
  const connection = await pool.getConnection();
  const lockName = `xflix:maintenance:${createHash('sha256').update(process.env.DB_NAME || 'xflix').digest('hex').slice(0, 32)}`;
  const state = { active: true };
  let acquired = false;
  try {
    const [[result]] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    acquired = result.acquired === 1;
    if (!acquired) {
      const error = new Error('Another maintenance operation is running');
      error.status = 409;
      throw error;
    }
    return await context.run(state, operation);
  } finally {
    state.active = false;
    if (acquired) {
      try { await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); }
      catch (_) { connection.destroy(); }
    }
    connection.release();
  }
}

module.exports = { withMaintenance };
