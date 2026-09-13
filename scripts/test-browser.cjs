'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { chromium } = require('playwright');
const runHarness = require('../test/frontend.browser.js');

async function main() {
  let child, childClosed, lines, launch, browser, page, result;
  let closed = false, cleaning = false;
  const errors = [];
  let interrupt, interruption;
  const interrupted = new Promise((resolve, reject) => {
    interrupt = error => { interruption ||= error; reject(error); };
  });
  const onSignal = signal => interrupt(new Error(`Browser tests interrupted: ${signal}`));
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  const onSighup = () => onSignal('SIGHUP');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);
  const watchdog = setTimeout(() => interrupt(new Error('Browser tests exceeded 180 seconds')), 180_000);

  try {
    child = spawn(process.execPath, [path.resolve(__dirname, '../test/frontend-server.js'), '--serve', '0', '127.0.0.1'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    childClosed = new Promise(resolve => child.once('close', (code, signal) => {
      closed = true;
      resolve();
      if (!cleaning) interrupt(new Error(`Frontend fixture exited unexpectedly (${signal || code})`));
    }));
    child.on('error', interrupt);
    const ready = new Promise((resolve, reject) => {
      lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        const prefix = 'Frontend fixture ready ';
        if (!line.startsWith(prefix)) return;
        try {
          const url = new URL(line.slice(prefix.length));
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) === 0
              || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            throw new Error(`Invalid frontend fixture URL: ${line}`);
          }
          resolve(url.origin);
        } catch (error) { reject(error); }
      });
    });
    const origin = await Promise.race([ready, interrupted]);
    console.log(`Browser tests: ${origin}`);
    launch = chromium.launch({
      headless: true,
      timeout: 30_000,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    browser = await Promise.race([launch, interrupted]);
    page = await Promise.race([browser.newPage({ serviceWorkers: 'block' }), interrupted]);
    result = await Promise.race([runHarness(page, origin), interrupted]);
  } catch (error) {
    errors.push(error);
  } finally {
    cleaning = true;
    // Keep cleanup bounded even if launch or browser.close never settles.
    const cleanupWatchdog = setTimeout(() => {
      console.error('Browser test cleanup exceeded 35 seconds');
      if (child && !closed) child.kill('SIGKILL');
      process.exit(1);
    }, 35_000);
    let killTimer;
    try {
      lines?.close();
      if (child && !closed) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 3_000);
      }
      const cleanup = await Promise.allSettled([
        // A signal can arrive while launch is pending; close that browser too.
        (async () => {
          if (!browser && launch) browser = await launch.catch(() => null);
          try {
            // Aborted harness requests can still have async route callbacks running.
            if (page) await page.unrouteAll({ behavior: 'ignoreErrors' });
          } finally {
            if (browser) await browser.close();
          }
        })(),
        childClosed,
      ]);
      for (const outcome of cleanup) {
        if (outcome.status === 'rejected') errors.push(outcome.reason);
      }
    } finally {
      clearTimeout(killTimer);
      clearTimeout(cleanupWatchdog);
      clearTimeout(watchdog);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.off('SIGHUP', onSighup);
    }
  }

  if (interruption && !errors.includes(interruption)) errors.push(interruption);
  if (errors.length) throw new AggregateError(errors, 'Browser tests failed');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
