'use strict';

const net = require('node:net');
const port = process.argv[2];
if (!/^\d+$/.test(port || '') || +port < 1024 || +port > 65535) process.exit(1);
const server = net.createServer();
server.on('error', () => {
  console.error('Application port is occupied; refusing to kill an unidentified process.');
  process.exitCode = 1;
});
server.listen(+port, '0.0.0.0', () => server.close());
