'use strict';

// Privileged helper: built-ins only, no dependency imports or evaluated config.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function fail(message) { throw new Error(message); }

function checkNodePath(nodePath) {
  if (!['/usr/bin/node', '/usr/local/lib/xflix-node/bin/node'].includes(nodePath)) fail('Unapproved Node executable');
  return nodePath;
}

function checkNodeVersion(version) {
  const match = /^v(22|24)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match || (+match[1] === 22 && +match[2] < 16)) fail('Production requires Node 22.x >=22.16.0 or 24.x >=24.0.0; prefer Node 24 LTS');
}

function checkNpmVersion(version, nodeVersion) {
  checkNodeVersion(nodeVersion);
  const match = /^(10|11|12)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) fail('npm 10.x, 11.x or 12.x is required');
  // npm 12 engines: ^22.22.2 || ^24.15.0 || >=26.0.0; Node 26 is not admitted here.
  if (+match[1] === 12) {
    const [major, minor, patch] = nodeVersion.slice(1).split('.').map(Number);
    if ((major === 22 && (minor < 22 || (minor === 22 && patch < 2))) || (major === 24 && minor < 15)) {
      fail('npm 12 requires Node 22.x >=22.22.2 or 24.x >=24.15.0');
    }
  }
}

function identifyExec(text, release) {
  const match = /^\{ path=([^ ;]+\/node) ; argv\[\]=([^;]+) ; ignore_errors=no ;[^{}]*\}$/.exec(text.trim());
  if (!match || match[2] !== `${match[1]} ${release}/server.js`) fail('Unidentified service command');
  checkNodePath(match[1]);
}

function validateAccount(account, entry, groups, passwd, group) {
  if (!['xflix', 'xflix-build'].includes(account) || entry[0] !== account ||
      !/^[1-9]\d*$/.test(entry[2]) || !/^[1-9]\d*$/.test(entry[3]) ||
      !(entry[5] === '/nonexistent' || (account === 'xflix' && entry[5] === '/opt/xflix')) ||
      entry[6] !== '/usr/sbin/nologin' || groups.length !== 1 || groups[0] !== entry[3]) fail('Account is not dedicated; repair manually');
  if (passwd.some(other => other[0] !== account && (other[2] === entry[2] || other[3] === entry[3] ||
      (entry[5] === '/opt/xflix' && other[5] === entry[5])))) fail('Account identity is shared');
  if (group[0] !== account || group[2] !== entry[3] || (group[3] && group[3] !== account)) fail('Account group is shared');
}

function parseAssignments(text, credentials = false) {
  const result = Object.create(null);
  if (text.includes('\0')) fail('NUL in configuration');
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || Object.hasOwn(result, match[1])) fail('Invalid or duplicate configuration key');
    let value = match[2];
    if (!credentials) {
      if (/^["']/.test(value)) {
        const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(value);
        if (!quoted || quoted[2].includes(quoted[1])) fail('Unsupported quoted configuration');
        value = quoted[2];
        if (quoted[1] === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
      } else {
        if (value.startsWith('`')) fail('Backtick quoting is not supported');
        value = value.split('#')[0].trim();
      }
    }
    // Legacy .admin-creds values are literal, including #, $, quotes and backslashes.
    if (/[\x00-\x1f\x7f]/.test(value)) fail('Control character in configuration');
    result[match[1]] = value;
  }
  return result;
}

function trusted(file) {
  const absolute = path.resolve(file);
  let current = '/';
  for (const part of absolute.split('/').filter(Boolean)) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) fail('Untrusted path ownership or permissions');
  }
  return fs.lstatSync(absolute);
}

function readSecret(file, uid = 0, allowedGroup = null) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== uid || (st.mode & 0o7137) ||
        ((st.mode & 0o040) && st.gid !== allowedGroup)) fail('Unsafe secret file permissions');
    if (st.size > 65536) fail('Configuration too large');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

function groupId() { return Number(execFileSync('/usr/bin/id', ['-g', 'xflix'], { encoding: 'utf8' }).trim()); }
function config(file) { trusted(path.dirname(file)); return parseAssignments(readSecret(file, 0, groupId())); }
function identifier(value) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value || '')) fail('Invalid database identifier');
  return value;
}
function validate(env) {
  for (const value of Object.values(env)) if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) fail('Invalid configuration value');
  identifier(env.DB_NAME);
  identifier(env.DB_USER);
  if (!['localhost', '127.0.0.1'].includes(env.DB_HOST || 'localhost') || (env.DB_PORT || '3306') !== '3306') fail('Only local MariaDB on port 3306 is supported');
  if (!env.DB_PASS || !env.JWT_SECRET || env.JWT_SECRET.length < 32) fail('Missing database password or strong JWT secret');
  if (env.REQUIRE_AUTH !== 'true') fail('REQUIRE_AUTH=true is required');
  if (Object.hasOwn(env, 'XFLIX_MEDIA_WRITE') && !['true', 'false'].includes(env.XFLIX_MEDIA_WRITE)) fail('XFLIX_MEDIA_WRITE must be exactly true or false');
  if (!/^\d+$/.test(env.PORT || '3000') || Number(env.PORT || 3000) < 1024 || Number(env.PORT || 3000) > 65535) fail('PORT must be unprivileged');
  const media = env.MEDIA_DIR || '';
  const forbidden = ['/root', '/home', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/sys', '/dev', '/run', '/var/backups', '/opt/xflix', '/opt/xflix-releases'];
  if (!/^\/[A-Za-z0-9_./ -]+$/.test(media) || path.normalize(media) !== media || ['/', '/opt', '/var', '/mnt', '/srv'].includes(media) ||
      forbidden.some(dir => media === dir || media.startsWith(dir + '/'))) fail('MEDIA_DIR must be a normalized non-system path outside code and home directories');
  if (env.THUMB_DIR && env.THUMB_DIR !== '/opt/xflix/data/thumbs') fail('Migrate THUMB_DIR to /opt/xflix/data/thumbs before installing');
  // Dotenv is loaded by the app, not by systemd or a shell. Prevent runtime injection.
  for (const key of Object.keys(env)) if (/^(NODE_|LD_|NPM_)|^(PATH|HOME|SHELL|BASH_ENV|ENV)$/.test(key)) fail('Runtime control variable refused');
  return env;
}
function provisionSQL(env) {
  validate(env);
  const literal = value => `'${value.replace(/'/g, "''")}'`;
  return `SET SESSION sql_mode='NO_BACKSLASH_ESCAPES';\nCREATE DATABASE \`${identifier(env.DB_NAME)}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\nCREATE USER ${literal(identifier(env.DB_USER))}@'localhost' IDENTIFIED BY ${literal(env.DB_PASS)};\nGRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, DROP ON \`${env.DB_NAME}\`.* TO ${literal(env.DB_USER)}@'localhost';\n`;
}

const sourceEntries = ['package.json', 'package-lock.json', 'server.js', 'db.js', 'scanner.js', 'cli.js', 'lib', 'middleware', 'routes', 'services', 'public', 'scripts'];
function copyTree(source, target, build = false, root = source) {
  const st = fs.lstatSync(source);
  if (st.isSymbolicLink()) {
    // npm's .bin links are allowed only when both lexical and real targets stay in the build.
    const link = fs.readlinkSync(source);
    const resolved = fs.realpathSync(source);
    const lexical = path.resolve(path.dirname(source), link);
    if (!build || path.isAbsolute(link) || !resolved.startsWith(root + '/') || !lexical.startsWith(root + '/')) fail('Unsafe symlink in release');
    fs.symlinkSync(link, target);
  } else if (st.isDirectory()) {
    if (!build && (st.uid !== 0 || (st.mode & 0o022))) fail('Untrusted source directory');
    fs.mkdirSync(target, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(target, name), build, root);
  } else if (st.isFile() && st.nlink === 1) {
    if (!build && (st.uid !== 0 || (st.mode & 0o022))) fail('Untrusted source file');
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    // Some runtime/filesystem copy implementations preserve source ownership.
    // A sealed release must belong to its copying operator, never the build user.
    fs.chownSync(target, process.getuid(), process.getgid());
    fs.chmodSync(target, st.mode & 0o111 ? 0o755 : 0o644);
  } else fail('Special file or hardlink refused');
}

function dataTree(dir, changeOwner = false) {
  const uid = Number(execFileSync('/usr/bin/id', ['-u', 'xflix'], { encoding: 'utf8' }).trim());
  const gid = groupId();
  function visit(file) {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()) || (st.isFile() && st.nlink !== 1) ||
        ![0, uid].includes(st.uid) || (st.mode & 0o022)) fail('Unsafe data tree; repair offline before installation');
    if (st.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    if (changeOwner) { fs.chownSync(file, uid, gid); fs.chmodSync(file, st.isDirectory() ? 0o750 : 0o640); }
  }
  visit(dir);
}

function checkMediaPath(media, { readOnly = false } = {}) {
  let current = '/';
  for (const part of media.split('/').filter(Boolean)) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    // Shared media may be untrusted; only the final directory gets the read-only exception.
    if (!st.isDirectory() || st.isSymbolicLink() ||
        ((st.mode & 0o002) && !(readOnly === true && current === media))) fail('Unsafe media root');
  }
}

function unit(release, env, nodePath = '/usr/bin/node') {
  checkNodePath(nodePath);
  if (!/^\/opt\/xflix-releases\/\d{8}T\d{6}Z-\d+$/.test(release)) fail('Invalid release path');
  validate(env);
  // Validation excludes quotes, backslashes and systemd specifiers; spaces stay one path.
  const mediaWrite = env.XFLIX_MEDIA_WRITE === 'true' ? `ReadWritePaths="${env.MEDIA_DIR}"\n` : '';
  return `[Unit]
Description=XFlix managed unprivileged service
After=network.target mariadb.service
Wants=mariadb.service

[Service]
Type=simple
User=xflix
Group=xflix
WorkingDirectory=${release}
ExecStart=${nodePath} ${release}/server.js
Environment=NODE_ENV=production
Environment=PATH=${nodePath === '/usr/bin/node' ? '' : '/usr/local/lib/xflix-node/bin:'}/usr/bin:/bin
Environment=THUMB_DIR=/opt/xflix/data/thumbs
UMask=0077
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
KillMode=control-group
TimeoutStopSec=120
SendSIGKILL=no
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
BindPaths=/opt/xflix/data:${release}/data
ReadWritePaths=/opt/xflix/data ${release}/data
${mediaWrite}StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

function validateUnit(text, release, env) {
  const match = /^ExecStart=(\S+) (\S+)$/m.exec(text);
  if (!match || match[2] !== `${release}/server.js` || unit(release, env, checkNodePath(match[1])) !== text) fail('Not a generated unprivileged unit');
  return match[1];
}

const stopPolicy = '[Service]\nRestart=no\nKillSignal=SIGTERM\nKillMode=control-group\nTimeoutStopSec=120\nSendSIGKILL=no\n';
const stopPolicyPath = '/run/systemd/system/xflix.service.d/90-xflix-maintenance.conf';

function verifyRelease(directory, root = directory) {
  const st = fs.lstatSync(directory);
  if (st.isSymbolicLink()) {
    const link = fs.readlinkSync(directory);
    if (path.isAbsolute(link) || !fs.realpathSync(directory).startsWith(root + '/')) fail('Unsafe release symlink');
    trusted(fs.realpathSync(directory));
  } else {
    trusted(directory);
    if (st.isDirectory()) for (const name of fs.readdirSync(directory)) verifyRelease(path.join(directory, name), root);
    else if (!st.isFile() || st.nlink !== 1) fail('Unsafe release file');
  }
}

function main([command, ...args]) {
  switch (command) {
    case 'trusted': trusted(args[0]); break;
    case 'regular': {
      const st = trusted(args[0]);
      if (!st.isFile() || st.nlink !== 1) fail('Not a regular single-link file');
      break;
    }
    case 'private-dir': {
      const st = trusted(args[0]);
      if (!st.isDirectory() || (st.mode & 0o077)) fail('Backup directory must be root-only');
      break;
    }
    case 'root-secret': trusted(path.dirname(args[0])); readSecret(args[0]); break;
    case 'secret': trusted(path.dirname(args[0])); readSecret(args[0], 0, groupId()); break;
    case 'account': {
      const entry = execFileSync('/usr/bin/getent', ['passwd', args[0]], { encoding: 'utf8' }).trim().split(':');
      const groups = execFileSync('/usr/bin/id', ['-G', args[0]], { encoding: 'utf8' }).trim().split(/\s+/);
      const passwd = execFileSync('/usr/bin/getent', ['passwd'], { encoding: 'utf8' }).trim().split('\n').map(line => line.split(':'));
      const group = execFileSync('/usr/bin/getent', ['group', entry[3]], { encoding: 'utf8' }).trim().split(':');
      validateAccount(args[0], entry, groups, passwd, group);
      if (entry[5] === '/opt/xflix') trusted(entry[5]);
      break;
    }
    case 'toolchain': {
      checkNodePath(args[0]);
      if (args.length !== 2 || args[1] !== path.join(path.dirname(args[0]), 'npm')) fail('Unapproved npm executable');
      for (const file of args) {
        trusted(path.dirname(file));
        const resolved = fs.realpathSync(file);
        if (!resolved.startsWith('/usr/')) fail('Toolchain must be system-wide under /usr, not a root-home symlink');
        if (args[0] === '/usr/local/lib/xflix-node/bin/node' &&
            (!resolved.startsWith('/usr/local/lib/xflix-node/') || (file === args[0] && resolved !== file))) fail('Isolated toolchain must stay in its fixed real directory');
        trusted(resolved);
        let current = path.dirname(resolved);
        while (current !== '/') {
          if (!(fs.statSync(current).mode & 0o001)) fail('Toolchain directory is not publicly traversable');
          current = path.dirname(current);
        }
        if ((fs.statSync(resolved).mode & 0o005) !== 0o005) fail('Toolchain is not publicly readable/executable');
      }
      const version = execFileSync(args[0], ['--version'], { encoding: 'utf8' }).trim();
      checkNodeVersion(version);
      checkNpmVersion(execFileSync(args[1], ['--version'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${path.dirname(args[0])}:/usr/sbin:/usr/bin:/sbin:/bin` },
      }).trim(), version);
      break;
    }
    case 'configure': {
      const [source, destination] = args;
      for (const name of ['.env', '.admin-creds']) {
        if (fs.existsSync(path.join(destination, name))) continue;
        if (fs.existsSync(path.join(source, name))) {
          fs.writeFileSync(path.join(destination, name), readSecret(path.join(source, name), 0, groupId()), { mode: 0o600, flag: 'wx' });
        } else if (name === '.env') {
          fs.writeFileSync(path.join(destination, name), `PORT=3000\nREQUIRE_AUTH=true\nTRUST_PROXY=loopback\nMEDIA_DIR=/mnt/media\nXFLIX_MEDIA_WRITE=false\nDB_HOST=localhost\nDB_PORT=3306\nDB_USER=xflix\nDB_NAME=xflix\nDB_PASS=${crypto.randomBytes(32).toString('hex')}\nJWT_SECRET=${crypto.randomBytes(48).toString('hex')}\nJWT_EXPIRES=12h\n`, { mode: 0o600, flag: 'wx' });
          if (!fs.existsSync(path.join(source, '.admin-creds')) && !fs.existsSync(path.join(destination, '.admin-creds'))) {
            fs.writeFileSync(path.join(destination, '.admin-creds'), `ADMIN_EMAIL=admin@xflix.local\nADMIN_PASS=${crypto.randomBytes(24).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
          }
        }
      }
      break;
    }
    case 'validate': validate(config(args[0])); break;
    case 'media': {
      const env = validate(config(args[0]));
      checkMediaPath(env.MEDIA_DIR, { readOnly: env.XFLIX_MEDIA_WRITE !== 'true' });
      break;
    }
    case 'media-path': process.stdout.write(validate(config(args[0])).MEDIA_DIR); break;
    case 'media-write': process.stdout.write(validate(config(args[0])).XFLIX_MEDIA_WRITE ?? 'false'); break;
    case 'db-name': process.stdout.write(identifier(config(args[0]).DB_NAME)); break;
    case 'exists-sql': process.stdout.write(`SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${identifier(config(args[0]).DB_NAME)}';\n`); break;
    case 'same-db': {
      const previous = config(args[0]);
      const next = config(args[1]);
      for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS']) {
        if (previous[key] !== next[key]) fail('Database settings changed; migrate separately before upgrading');
      }
      break;
    }
    case 'port': process.stdout.write(validate(config(args[0])).PORT || '3000'); break;
    case 'provision': process.stdout.write(provisionSQL(config(args[0]))); break;
    case 'credentials': {
      const file = path.join(args[0], '.admin-creds');
      process.stdout.write(JSON.stringify(fs.existsSync(file) ? parseAssignments(readSecret(file, 0, groupId()), true) : {}));
      break;
    }
    case 'stage':
      for (const name of sourceEntries) copyTree(path.join(args[0], name), path.join(args[1], name));
      break;
    case 'seal':
      for (const file of ['package.json', 'package-lock.json']) {
        if (!fs.readFileSync(path.join(args[0], file)).equals(fs.readFileSync(path.join(args[1], file)))) fail('Build manifests changed');
      }
      fs.mkdirSync(args[2], { mode: 0o755 });
      fs.chmodSync(args[2], 0o755);
      // The build user must not be able to replace bootstrap/healthcheck code run later.
      for (const name of sourceEntries) copyTree(path.join(args[0], name), path.join(args[2], name));
      copyTree(path.join(args[1], 'node_modules'), path.join(args[2], 'node_modules'), true, args[1]);
      verifyRelease(args[2]);
      break;
    case 'old-release':
      if (args[0] !== '/opt/xflix' && !/^\/opt\/xflix-releases\/\d{8}T\d{6}Z-\d+$/.test(args[0])) fail('Unknown service working directory');
      trusted(args[0]);
      break;
    case 'identify-exec': identifyExec(fs.readFileSync(0, 'utf8'), args[0]); break;
    case 'data': dataTree(args[0]); break;
    case 'own-data': dataTree(args[0], true); break;
    case 'unit': {
      const nodePath = checkNodePath(process.execPath);
      checkNodeVersion(process.version);
      const env = validate(config(args[1]));
      checkMediaPath(env.MEDIA_DIR, { readOnly: env.XFLIX_MEDIA_WRITE !== 'true' });
      process.stdout.write(unit(args[0], env, nodePath));
      break;
    }
    case 'stop-policy': {
      trusted('/run/systemd');
      for (const dir of ['/run/systemd/system', '/run/systemd/system/xflix.service.d']) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o755 });
        trusted(dir);
      }
      if (fs.existsSync(stopPolicyPath)) {
        trusted(stopPolicyPath);
        if (fs.readFileSync(stopPolicyPath, 'utf8') !== stopPolicy) fail('Unexpected maintenance policy');
      } else fs.writeFileSync(stopPolicyPath, stopPolicy, { mode: 0o644, flag: 'wx' });
      break;
    }
    case 'clear-stop-policy': {
      if (fs.existsSync(stopPolicyPath)) {
        trusted(stopPolicyPath);
        if (fs.readFileSync(stopPolicyPath, 'utf8') !== stopPolicy) fail('Unexpected maintenance policy');
        fs.unlinkSync(stopPolicyPath);
      }
      break;
    }
    case 'rollback-check': {
      if (!/^\/var\/backups\/xflix\/\d{8}T\d{6}Z-\d+$/.test(args[0])) fail('Invalid backup path');
      const st = trusted(args[0]);
      if (!st.isDirectory() || (st.mode & 0o077)) fail('Unsafe backup directory');
      readSecret(path.join(args[0], 'complete'));
      const release = readSecret(path.join(args[0], 'previous-release')).trim();
      const oldEnv = readSecret(path.join(args[0], '.env'));
      const env = validate(parseAssignments(oldEnv));
      // Restore the saved runtime and media policy, never the helper's current runtime.
      validateUnit(readSecret(path.join(args[0], 'previous.service')), release, env);
      verifyRelease(release);
      checkMediaPath(env.MEDIA_DIR, { readOnly: env.XFLIX_MEDIA_WRITE !== 'true' });
      if (readSecret(path.join(release, '.env'), 0, groupId()) !== oldEnv) fail('Previous release configuration changed');
      process.stdout.write(release);
      break;
    }
    case 'managed-unit': {
      const st = trusted(args[0]);
      if (!st.isFile() || st.nlink !== 1) fail('Not a regular single-link unit');
      const text = fs.readFileSync(args[0], 'utf8');
      const match = /^WorkingDirectory=(\/opt\/xflix-releases\/\d{8}T\d{6}Z-\d+)$/m.exec(text);
      if (!match) fail('Not a generated unprivileged unit');
      process.stdout.write(validateUnit(text, match[1], config(path.join(match[1], '.env'))));
      break;
    }
    default: fail('Unknown installer helper command');
  }
}

if (require.main === module) {
  process.umask(0o077);
  try { main(process.argv.slice(2)); }
  catch (_) { console.error('Installer precondition failed (no secret values logged). See scripts/INSTALLATION.md.'); process.exitCode = 1; }
}
module.exports = { checkNodePath, checkNodeVersion, checkNpmVersion, identifyExec, validateAccount, parseAssignments, readSecret, validate, identifier, provisionSQL, copyTree, checkMediaPath, unit, validateUnit };
