/**
 * server.js — XFlix entry point
 *
 * Boots Express, registers all routers and starts listening.
 * DB schema is initialised here with automatic retry so the process
 * survives MariaDB taking a few seconds to be ready on startup.
 *
 * Route map
 * ─────────
 *   /auth/**      — register, login, password-reset, profile  (routes/auth.js)
 *   /social/**    — comments, reactions, per-user favourites   (routes/social.js)
 *   /admin/**     — scan, users, settings, duplicates, clean   (routes/admin.js)
 *   /api/**       — performers, media, search, stats           (routes/api.js)
 *   /stream/:id   — video streaming with Range support         (routes/stream.js)
 *   /photo/:id    — photo serving with ETag cache              (routes/stream.js)
 *   /thumb/:id    — thumbnail serving + on-demand generation   (routes/stream.js)
 *   /download/:id — force-download with original filename      (routes/stream.js)
 *
 * Environment variables → see .env.example
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const { initSchema, pool } = require('./db');

// ── Empêche tout crash sur rejection/exception non gérée ──────────
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
  // L'état du processus peut être corrompu — on laisse PM2 redémarrer
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason);
});
pool.on('error', (err) => {
  console.error('[pool error]', err.message);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.CORS_ORIGIN || true,   // 'true' = reflect request origin (same as wildcard but sends Vary)
  credentials: true,
}));

// Security headers (CSP is relaxed for inline styles/scripts used by the SPA)
app.use(helmet({
  contentSecurityPolicy: false,     // SPA uses inline scripts/styles
  crossOriginEmbedderPolicy: false, // video/image streaming cross-origin
}));

// Gzip all JSON/HTML/CSS/JS (skip video/image — already compressed or streamed)
// Also skip SSE (text/event-stream) since compression buffers and breaks streaming
app.use(compression({
  filter: (req, res) => {
    const ct = res.getHeader('Content-Type') || '';
    if (/video|image|event-stream/.test(ct)) return false;
    return compression.filter(req, res);
  },
  level: 6,
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));


app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,              // toujours revalider (ETag/304)
  etag: true,
  lastModified: true,
}));

// Routes
app.use('/auth',      require('./routes/auth'));
app.use('/social',    require('./routes/social'));
app.use('/admin',     require('./routes/admin'));
app.use('/api',       require('./routes/api'));
app.use('/',          require('./routes/stream'));

// SPA fallback — serve index.html for any unknown route so the
// client-side router can handle deep links (e.g. /reset-password?token=…)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Init DB schema with retry — handles MariaDB still starting up
async function startServer(maxAttempts = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initSchema();
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n  🎬  XFlix running at http://localhost:${PORT}  (MariaDB)\n`);
      });
      return;
    } catch (e) {
      if (attempt === maxAttempts) {
        console.error(`\n  ❌  Impossible de démarrer après ${maxAttempts} tentatives.`);
        console.error(`  DB error: ${e.message}`);
        console.error('  Vérifiez que MariaDB est lancé et que les identifiants .env sont corrects.');
        process.exit(1);
      }
      console.warn(`  ⏳  DB non disponible (tentative ${attempt}/${maxAttempts}) : ${e.message}`);
      console.warn(`  ↻   Nouvelle tentative dans ${delayMs / 1000}s…`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

startServer();
