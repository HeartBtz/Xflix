'use strict';
// Static-only fixture server. Never imports the application or connects to a DB.
// Run: node test/frontend-server.js --serve [port] [bind-address]
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../public');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/__test/browser') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await fs.readFile(path.join(__dirname, 'frontend.browser.js'))); return;
    }
    if (req.method !== 'GET' || /^(\/api|\/auth|\/social|\/admin\/|\/stream|\/photo|\/thumb|\/download)/.test(pathname)) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end('{"error":"Fixture: API must be intercepted by the browser harness"}'); return;
    }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
// Explicit opt-in also keeps the default `node --test` discovery side-effect free.
if (process.argv[2] === '--serve') {
  const port = process.argv[3] === undefined ? 18765 : Number(process.argv[3]);
  server.listen(port, process.argv[4] || '127.0.0.1', () => {
    console.log(`Frontend fixture ready http://${server.address().address}:${server.address().port}`);
  });
}
