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
