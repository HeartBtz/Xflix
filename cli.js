/**
 * cli.js — Command-line interface for XFlix
 *
 * Usage:
 *   node cli.js scan [all|photos|videos]   Scan MEDIA_DIR and index new files
 *   node cli.js clear                      Truncate all media tables (keeps users)
 *
 * The CLI uses the same db.js and scanner.js modules as the server,
 * so it inherits all environment variables from .env.
 *
 * Typical workflow after first install:
 *   node cli.js scan          # index everything
 *   node server.js            # start the API server
 *
 * Or trigger a scan from the browser: Admin panel → ▶ Lancer un scan.
 */
require('dotenv').config();
const { initSchema, clearAll } = require('./db');
const { scanDirectory, getProgress, enrichDurations, generateMissingThumbs } = require('./scanner');

const [,, cmd, arg] = process.argv;

async function main() {
  await initSchema();

  if (cmd === 'scan') {
    const mode = ['photos', 'videos', 'all'].includes(arg) ? arg : 'all';
    console.log(`Starting scan (${mode})...`);
    try {
      await scanDirectory(mode);
      const p = getProgress();
      console.log(`\n✅ Scan complete! ${p.done} files indexed, ${p.errors} errors.`);
      if (mode === 'all' || mode === 'videos') {
        console.log('⏳  Enrichissement des durées vidéo…');
        await enrichDurations(3);
        console.log('✅  Durées enrichies.');
      }
      console.log('⏳  Génération des miniatures manquantes…');
      await generateMissingThumbs(300, 3);
      console.log('✅  Miniatures générées.');
    } catch(e) {
      console.error('❌ Scan failed:', e.message);
      process.exit(1);
    }
  } else if (cmd === 'clear') {
    await clearAll();
    console.log('✅ Database cleared.');
  } else {
    console.log('Usage: node cli.js [scan [all|photos|videos] | clear]');
    process.exit(1);
  }
  process.exit(0);
}

main();
