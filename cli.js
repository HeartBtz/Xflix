'use strict';

async function main(args = process.argv.slice(2)) {
  const [command, argument] = args;
  const validScan = command === 'scan' && args.length <= 2 && (argument === undefined || ['all', 'photos', 'videos'].includes(argument));
  const validClear = command === 'clear' && args.length === 2 && argument === '--confirm';
  // Validate before loading DB/scanner modules or creating directories/schema.
  if (!validScan && !validClear) throw new Error('Usage: node cli.js scan [all|photos|videos] | clear --confirm');
  require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
  const { initSchema, clearAll, pool } = require('./db');
  const { runScan } = require('./scanner');
  const { withMaintenance } = require('./lib/maintenance');
  try {
    await withMaintenance(async () => {
      await initSchema();
      if (validClear) {
        await clearAll();
        console.log('Database cleared. Users and settings retained.');
        return;
      }
      const mode = argument || 'all';
      console.log(`Starting scan (${mode})...`);
      const progress = await runScan(mode);
      console.log(`Scan ${progress.phase}: ${progress.done} files indexed, ${progress.errors} errors.`);
      if (!progress.completed) process.exitCode = 1;
    });
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { main };
