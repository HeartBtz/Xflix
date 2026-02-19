require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const { initSchema } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
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
app.use(express.json());
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

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Init DB schema then start server
initSchema().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  🎬  XFlix running at http://localhost:${PORT}  (MariaDB)\n`);
  });
}).catch(e => {
  console.error('Failed to initialize database:', e.message);
  process.exit(1);
});
