'use strict';

const http = require('node:http');

function probe(port, timeout = 2000) {
  if (!/^\d+$/.test(String(port)) || +port < 1024 || +port > 65535) return Promise.reject(new Error('Invalid port'));
  return new Promise((resolve, reject) => {
    let deadline;
    const finish = error => {
      clearTimeout(deadline);
      if (error) reject(error); else resolve();
    };
    // /auth/me exercises the auth router without credentials. SPA HTML is not health.
    const request = http.get({ hostname: '127.0.0.1', port: +port, path: '/auth/me', timeout, agent: false }, response => {
      let body = '';
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 8192) request.destroy(new Error('Oversized health response'));
      });
      response.on('error', finish);
      response.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (response.statusCode !== 401 || !/^application\/json\b/i.test(response.headers['content-type'] || '') || typeof json.error !== 'string') throw new Error('Unexpected health response');
          finish();
        } catch (_) { finish(new Error('Unexpected health response')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Health request timed out')));
    deadline = setTimeout(() => request.destroy(new Error('Health deadline exceeded')), timeout);
    request.on('error', finish);
  });
}

async function healthcheck(port, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await probe(port); return; }
    catch (_) { if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  throw new Error('Local HTTP healthcheck failed (not equivalent to systemd is-active)');
}

if (require.main === module) healthcheck(process.argv[2] || '3000').then(() => {
  console.log('Local unauthenticated HTTP auth-router check passed; not a DB/restore readiness guarantee.');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { probe, healthcheck };
