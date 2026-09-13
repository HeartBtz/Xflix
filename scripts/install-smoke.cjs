'use strict';

if (process.getuid() === 0) throw new Error('Dependency checks must not run as root');
require('sharp')({ create: { width: 1, height: 1, channels: 3, background: '#000000' } })
  .png().toBuffer().then(() => console.log('sharp native smoke test passed'))
  .catch(() => { console.error('sharp native smoke test failed'); process.exitCode = 1; });
