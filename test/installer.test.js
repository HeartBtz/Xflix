'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { checkNodePath, checkNodeVersion, checkNpmVersion, identifyExec, validateAccount, parseAssignments, readSecret, validate, identifier, provisionSQL, copyTree, checkMediaPath, unit, validateUnit } = require('../scripts/install-config.cjs');
const { probe } = require('../scripts/healthcheck.cjs');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const valid = () => ({ DB_NAME: 'xflix', DB_USER: 'xflix', DB_PASS: 'dummy-password', JWT_SECRET: 'j'.repeat(48), MEDIA_DIR: '/mnt/media', REQUIRE_AUTH: 'true', PORT: '3000' });
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xflix-installer-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('configuration is data: literals, comments, quotes and CRLF match dotenv', () => {
  const text = '# Dummy values only\r\nDB_PASS="a\'b#c$()\\z" # comment\r\nPORT=3000\nJWT_SECRET=abc#comment\nEMPTY=\n';
  const parsed = parseAssignments(text);
  assert.deepEqual({ ...parsed }, require('dotenv').parse(text));
  assert.equal(parsed.DB_PASS, "a'b#c$()\\z");
  assert.equal(Object.getPrototypeOf(parsed), null);
});

test('production toolchain admits supported Node 22/24 floors, not EOL Node 20 or floating majors', () => {
  for (const version of ['v22.16.0', 'v22.16.1', 'v22.22.2', 'v24.0.0', 'v24.15.0', 'v24.20.0']) assert.doesNotThrow(() => checkNodeVersion(version));
  for (const version of ['v18.20.0', 'v20.9.0', 'v20.19.2', 'v20.99.0', 'v22.1.0', 'v22.15.99', 'v23.11.0', 'v25.0.0', 'v26.0.0', 'v24.0.0-rc.1', 'v24.00.0', 'lts/*', '24.20.0']) assert.throws(() => checkNodeVersion(version));
});

test('npm 10/11/12 compatibility is checked against the admitted Node runtime', () => {
  for (const npm of ['10.9.0', '11.0.0']) {
    for (const node of ['v22.16.0', 'v24.0.0', 'v24.20.0']) assert.doesNotThrow(() => checkNpmVersion(npm, node));
  }
  for (const node of ['v22.22.2', 'v22.23.0', 'v24.15.0', 'v24.20.0']) assert.doesNotThrow(() => checkNpmVersion('12.0.2', node));
  for (const node of ['v22.16.0', 'v22.22.1', 'v24.0.0', 'v24.14.99']) assert.throws(() => checkNpmVersion('12.0.2', node));
  for (const npm of ['9.9.4', '13.0.0', '11.0.0-rc.1', 'v11.0.0', '12', '12.00.2', 'latest']) assert.throws(() => checkNpmVersion(npm, 'v24.20.0'));
  for (const npm of ['10.9.0', '11.0.0', '12.0.2']) assert.throws(() => checkNpmVersion(npm, 'v20.19.2'));
});

test('installer and CI keep the npm version command and share compatibility guards', () => {
  const helper = read('scripts/install-config.cjs');
  const ci = read('scripts/ci-validate.sh');
  assert.match(helper, /checkNpmVersion\(execFileSync\(args\[1\], \['--version'\]/);
  assert.match(ci, /NPM_VERSION=\$\(npm --version\)/);
  assert.match(ci, /checkNpmVersion\(process\.argv\[1\], process\.version\)/);
  assert.ok(ci.indexOf('checkNpmVersion(') < ci.indexOf('npm ci '));
});

test('service identification requires the exact Node/server argv, not a substring or wrapper', () => {
  const command = '{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/xflix/server.js ; ignore_errors=no ; pid=123 ; code=(null) ; status=0/0 }';
  assert.doesNotThrow(() => identifyExec(command, '/opt/xflix'));
  assert.doesNotThrow(() => identifyExec(command.replaceAll('/usr/bin/node', '/usr/local/lib/xflix-node/bin/node'), '/opt/xflix'));
  assert.throws(() => identifyExec(command.replaceAll('/usr/bin/node', '/root/.nvm/versions/node/v20.19.2/bin/node'), '/opt/xflix'));
  for (const altered of [command.replace('server.js ;', 'server.js-evil ;'), command.replace('server.js ;', 'server.js --flag ;'), command + command, command.replace('path=/usr/bin/node', 'path=/bin/sh')]) {
    assert.throws(() => identifyExec(altered, '/opt/xflix'));
  }
});

test('legacy admin values retain # and shell syntax without evaluation', () => {
  const parsed = parseAssignments('ADMIN_EMAIL=a@example.test\nADMIN_PASS=$(touch /never-execute);\'"#\\`\n', true);
  assert.equal(parsed.ADMIN_PASS, '$(touch /never-execute);\'"#\\`');
  assert.throws(() => parseAssignments('source /not-a-config\n', true));
});

test('ambiguous or multiline configuration is rejected, not silently reinterpreted', () => {
  for (const text of ['PORT=3000\nPORT=4000', 'export PORT=3000', 'DB_PASS="unterminated', 'DB_PASS="a"b"', 'DB_PASS="a\\nb"', 'A=x\0', 'A=`value`']) {
    assert.throws(() => parseAssignments(text));
  }
});

test('database names, path injection and runtime override inputs fail closed', () => {
  for (const name of ['x`; DROP DATABASE mysql;--', 'x.y', '../x', 'x\n', 'x'.repeat(65), '']) assert.throws(() => identifier(name));
  for (const [key, value] of [['PORT', '80'], ['PORT', '70000'], ['PORT', '3000\nUser=root'], ['DB_HOST', 'db.example.test'], ['DB_PORT', '3307'], ['MEDIA_DIR', '/root/media'], ['MEDIA_DIR', '/mnt/../etc'], ['MEDIA_DIR', '/srv/a%h'], ['THUMB_DIR', '/etc'], ['REQUIRE_AUTH', 'false'], ['NODE_OPTIONS', '--require=evil']]) {
    assert.throws(() => validate({ ...valid(), [key]: value }));
  }
  assert.equal(validate(valid()).DB_NAME, 'xflix');
});

test('fresh database SQL uses bounded identifiers and quotes with fixed SQL mode', () => {
  const password = "p'\\; DROP USER 'root'@'localhost';--";
  const sql = provisionSQL({ ...valid(), DB_PASS: password });
  assert.ok(sql.startsWith("SET SESSION sql_mode='NO_BACKSLASH_ESCAPES';\n"));
  assert.ok(sql.includes("IDENTIFIED BY 'p''\\; DROP USER ''root''@''localhost'';--';"));
  assert.doesNotMatch(sql, /GRANT ALL|GRANT OPTION|ALTER USER|FLUSH PRIVILEGES/);
  assert.throws(() => provisionSQL({ ...valid(), DB_NAME: 'x`' }));
});

test('secret reads reject symlinks, hardlinks, public/group writable files and wrong owners', t => {
  const dir = temporary(t);
  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, 'DB_PASS=dummy', { mode: 0o600 });
  assert.equal(readSecret(file, process.getuid()), 'DB_PASS=dummy');
  assert.throws(() => readSecret(file, process.getuid() + 1));
  for (const mode of [0o644, 0o660, 0o700, 0o4600]) {
    fs.chmodSync(file, mode);
    assert.throws(() => readSecret(file, process.getuid()));
  }
  fs.chmodSync(file, 0o640);
  assert.throws(() => readSecret(file, process.getuid()));
  assert.equal(readSecret(file, process.getuid(), process.getgid()), 'DB_PASS=dummy');
  fs.chmodSync(file, 0o600);
  fs.symlinkSync(file, path.join(dir, 'link'));
  assert.throws(() => readSecret(path.join(dir, 'link'), process.getuid()));
  fs.linkSync(file, path.join(dir, 'hardlink'));
  assert.throws(() => readSecret(file, process.getuid()));
  const fifo = path.join(dir, 'fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  assert.throws(() => readSecret(fifo, process.getuid()));
});

test('release copy refuses external links and normalizes executable permissions', t => {
  const dir = temporary(t);
  const source = path.join(dir, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'cli'), 'dummy', { mode: 0o700 });
  if (process.getuid() === 0) fs.chownSync(path.join(source, 'cli'), 65534, 65534);
  fs.symlinkSync('cli', path.join(source, 'internal'));
  const destination = path.join(dir, 'release');
  copyTree(source, destination, true, source);
  assert.equal(fs.readlinkSync(path.join(destination, 'internal')), 'cli');
  assert.equal(fs.statSync(path.join(destination, 'cli')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(destination, 'cli')).uid, process.getuid());
  assert.equal(fs.statSync(path.join(destination, 'cli')).gid, process.getgid());
  assert.equal(fs.statSync(destination).mode & 0o777, 0o755);
  fs.symlinkSync('/etc/passwd', path.join(source, 'escape'));
  assert.throws(() => copyTree(source, path.join(dir, 'bad'), true, source));
  assert.throws(() => copyTree(path.join(source, 'internal'), path.join(dir, 'source-link')));
});

test('generated unit never runs root and only data is writable', () => {
  const text = unit('/opt/xflix-releases/20260905T120000Z-123', valid());
  for (const line of ['User=xflix', 'Group=xflix', 'CapabilityBoundingSet=', 'AmbientCapabilities=', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', 'SendSIGKILL=no', 'KillSignal=SIGTERM', 'UMask=0077']) assert.ok(text.split('\n').includes(line));
  assert.match(text, /^ExecStart=\/usr\/bin\/node \/opt\/xflix-releases\//m);
  assert.match(text, /^Environment=THUMB_DIR=\/opt\/xflix\/data\/thumbs$/m);
  assert.doesNotMatch(text, /\/root\/|ReadWritePaths=.*\/mnt\/|User=root/);
  assert.throws(() => unit('/opt/xflix', valid()));
  assert.throws(() => unit('/opt/xflix-releases/x\nUser=root', valid()));
});

test('fixed isolated runtime is the only alternative, with a matching service PATH', () => {
  const release = '/opt/xflix-releases/20260905T120000Z-123';
  const system = unit(release, valid());
  const isolated = unit(release, valid(), '/usr/local/lib/xflix-node/bin/node');
  assert.equal(isolated, system.replace('ExecStart=/usr/bin/node ', 'ExecStart=/usr/local/lib/xflix-node/bin/node ')
    .replace('Environment=PATH=/usr/bin:/bin', 'Environment=PATH=/usr/local/lib/xflix-node/bin:/usr/bin:/bin'));
  for (const node of ['/tmp/node', '/usr/local/bin/node', '/usr/bin/../bin/node', '/usr/local/lib/xflix-node/bin/node --flag', '/usr/bin/node\nUser=root', '/usr/bin/node%h', '', null]) {
    assert.throws(() => checkNodePath(node));
    assert.throws(() => unit(release, valid(), node));
  }
});

test('main unit uses its validated executable, while Node 20 is refused only at the production entry point', () => {
  const release = '/opt/xflix-releases/20260905T120000Z-123';
  for (const execPath of ['/usr/bin/node', '/usr/local/lib/xflix-node/bin/node', '/tmp/node']) {
    for (const version of ['v20.19.2', 'v24.20.0']) {
      let output = '';
      const context = vm.createContext({ require, module: { exports: {} },
        process: { execPath, version, stdout: { write: text => { output += text; } } }, env: valid(), release });
      // Supply config in memory; the actual main/unit dispatch and guards run without host changes.
      const code = read('scripts/install-config.cjs') + '\nconfig = () => env; checkMediaPath = () => {}; main(["unit", release, "/fixture/.env"]);';
      if (version === 'v20.19.2' || execPath === '/tmp/node') {
        assert.throws(() => vm.runInContext(code, context), /Production requires Node|Unapproved Node executable/);
        assert.equal(output, '');
      } else {
        vm.runInContext(code, context);
        assert.equal(output, unit(release, valid(), execPath));
      }
    }
  }
});

test('saved units preserve either runtime and media policy, refusing altered commands or PATH', () => {
  const release = '/opt/xflix-releases/20260905T120000Z-123';
  for (const node of ['/usr/bin/node', '/usr/local/lib/xflix-node/bin/node']) {
    for (const flag of [undefined, 'false', 'true']) {
      const env = valid();
      if (flag !== undefined) env.XFLIX_MEDIA_WRITE = flag;
      const text = unit(release, env, node);
      assert.equal(validateUnit(text, release, env), node);
      for (const altered of [text.replace(node, '/tmp/node'), text.replace('server.js\n', 'server.js --flag\n'),
        text.replace('Environment=PATH=', 'Environment=PATH=/tmp:'), text + `ExecStart=${node} ${release}/server.js\n`,
        text.replace('User=xflix', 'User=root')]) assert.throws(() => validateUnit(altered, release, env));
      assert.throws(() => validateUnit(text, '/opt/xflix-releases/20260905T120000Z-456', env));
      if (flag === 'true') assert.throws(() => validateUnit(text, release, valid()));
    }
  }
});

test('toolchain preflight rejects runtime injection and escapes before execution; npm gets the selected node PATH', () => {
  const bin = '/usr/local/lib/xflix-node/bin';
  const run = (args, realpaths = {}, unsafe = '') => {
    const calls = [];
    const stat = file => ({ uid: 0, mode: 0o755, isSymbolicLink: () => file === unsafe });
    const context = vm.createContext({ module: { exports: {} }, args,
      process: { env: { PATH: '/tmp/injected' } },
      require: name => name === 'node:fs' ? {
        lstatSync: stat, statSync: stat, realpathSync: file => realpaths[file] || file,
      } : name === 'node:child_process' ? { execFileSync: (file, argv, options) => {
        calls.push({ file, argv, options });
        return file.endsWith('/npm') ? '12.0.2\n' : 'v24.20.0\n';
      } } : require(name),
    });
    try { vm.runInContext(read('scripts/install-config.cjs') + '\nmain(["toolchain", ...args]);', context); }
    catch (error) { assert.equal(calls.length, 0); throw error; }
    return calls;
  };
  for (const prefix of ['/usr/bin', bin]) {
    const calls = run([`${prefix}/node`, `${prefix}/npm`], { [`${prefix}/npm`]: prefix === bin ? '/usr/local/lib/xflix-node/lib/node_modules/npm/bin/npm-cli.js' : '/usr/share/nodejs/npm/bin/npm-cli.js' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.env.PATH, `${prefix}:/usr/sbin:/usr/bin:/sbin:/bin`);
  }
  for (const args of [['/tmp/node', '/tmp/npm'], [`${bin}/node`, '/usr/bin/npm'], ['/usr/bin/node', '/tmp/npm'], [`${bin}/node`, `${bin}/npm`, '/tmp/extra']]) assert.throws(() => run(args));
  for (const file of [`${bin}/node`, `${bin}/npm`]) {
    assert.throws(() => run([`${bin}/node`, `${bin}/npm`], { [file]: '/usr/bin/node' }));
  }
  assert.throws(() => run([`${bin}/node`, `${bin}/npm`], {}, '/usr/local/lib/xflix-node'));
});

test('legacy home is allowed only for the dedicated xflix identity, never xflix-build or shared accounts', () => {
  const entry = 'xflix:x:999:991::/opt/xflix:/usr/sbin/nologin'.split(':');
  const group = ['xflix', 'x', '991', ''];
  const check = (user = entry, groups = ['991'], passwd = [user], g = group) => validateAccount(user[0], user, groups, passwd, g);
  assert.doesNotThrow(() => check());
  assert.doesNotThrow(() => check(entry.with(5, '/nonexistent')));
  assert.doesNotThrow(() => check(entry.with(0, 'xflix-build').with(5, '/nonexistent'), ['991'], [], group.with(0, 'xflix-build')));
  for (const [index, value] of [[0, 'other'], [0, 'xflix-build'], [2, '0'], [3, '0'], [5, '/home/xflix'], [5, '/opt/xflix/'], [6, '/bin/bash']]) {
    assert.throws(() => check(entry.with(index, value)));
  }
  assert.throws(() => check(entry, ['991', '27']));
  assert.throws(() => check(entry, ['27']));
  assert.throws(() => check(entry, ['991'], [entry], group.with(3, 'other')));
  for (const index of [2, 3, 5]) {
    const other = 'other:x:1001:1001::/nonexistent:/usr/sbin/nologin'.split(':').with(index, entry[index]);
    assert.throws(() => check(entry, ['991'], [entry, other]));
  }
  assert.match(read('scripts/install-config.cjs'), /if \(entry\[5\] === '\/opt\/xflix'\) trusted\(entry\[5\]\)/);
});

test('installer selects only a complete fixed runtime and carries it through build, migration and rollback health', () => {
  for (const file of ['install.sh', 'scripts/rollback.sh']) {
    const shell = read(file);
    assert.match(shell, /NODE=\/usr\/bin\/node\nNPM=\/usr\/bin\/npm/);
    assert.match(shell, /if \[\[ -x \/usr\/local\/lib\/xflix-node\/bin\/node && -x \/usr\/local\/lib\/xflix-node\/bin\/npm \]\]; then\n\s+NODE=\/usr\/local\/lib\/xflix-node\/bin\/node\n\s+NPM=\/usr\/local\/lib\/xflix-node\/bin\/npm/);
    assert.match(shell, /export PATH=\/usr\/local\/lib\/xflix-node\/bin:\$PATH/);
    assert.match(shell, /helper toolchain "\$NODE" "\$NPM"/);
    assert.ok(shell.indexOf('Unsafe isolated runtime permissions.') < shell.indexOf('helper toolchain'));
    assert.doesNotMatch(shell, /(?:NODE|NPM)=\$\{|XFLIX_NODE|XFLIX_NPM/);
  }
  assert.match(read('install.sh'), /HOME="\$STAGE" PATH="\$PATH" \/bin\/bash/);
  assert.match(read('install.sh'), /PATH="\$PATH" NODE_ENV=production "\$NODE" "\$RELEASE\/scripts\/install-db.cjs"/);
  assert.match(read('scripts/install-prepare.sh'), /^npm ci /m);
  assert.match(read('scripts/install-prepare.sh'), /^node scripts\/install-smoke.cjs$/m);
  const rollback = read('scripts/rollback.sh');
  assert.match(rollback, /ROLLBACK_NODE=\$\(helper managed-unit "\$BACKUP\/previous.service"\)/);
  assert.match(rollback, /helper toolchain "\$ROLLBACK_NODE" "\$\{ROLLBACK_NODE%\/\*\}\/npm"/);
  assert.ok(rollback.indexOf('helper toolchain "$ROLLBACK_NODE"') < rollback.indexOf('helper stop-policy'));
  assert.match(rollback, /"\$ROLLBACK_NODE" "\$SOURCE\/scripts\/healthcheck.cjs"/);
  assert.equal(fs.statSync(path.join(root, 'install.sh')).mode & 0o100, 0o100);
});

test('media-write config accepts only explicit lowercase booleans without opting in legacy configs', () => {
  const legacy = valid();
  validate(legacy);
  assert.equal(Object.hasOwn(legacy, 'XFLIX_MEDIA_WRITE'), false);
  for (const value of ['true', 'false']) {
    const parsed = parseAssignments(`XFLIX_MEDIA_WRITE=${value}\n`);
    assert.equal(validate({ ...valid(), ...parsed }).XFLIX_MEDIA_WRITE, value);
  }
  for (const value of ['', '1', '0', 'yes', 'no', 'TRUE', 'False', ' true ', 'true#comment', true, false, null, undefined]) {
    assert.throws(() => validate({ ...valid(), XFLIX_MEDIA_WRITE: value }));
  }
  assert.match(read('scripts/install-config.cjs'), /MEDIA_DIR=\/mnt\/media\\nXFLIX_MEDIA_WRITE=false\\n/);
  assert.match(read('.env.example'), /^XFLIX_MEDIA_WRITE=false$/m);
});

test('media-write opt-in adds exactly one quoted path, without relaxing any other sandbox setting', () => {
  const release = '/opt/xflix-releases/20260905T120000Z-123';
  for (const media of ['/mnt/media', '/srv/My Photos', '/media/archive', '/mnt/library']) {
    const env = { ...valid(), MEDIA_DIR: media };
    const legacy = unit(release, env);
    const readOnly = unit(release, { ...env, XFLIX_MEDIA_WRITE: 'false' });
    const writable = unit(release, { ...env, XFLIX_MEDIA_WRITE: 'true' });
    assert.equal(legacy, readOnly);
    assert.deepEqual(readOnly.split('\n').filter(line => line.startsWith('ReadWritePaths=')), [
      `ReadWritePaths=/opt/xflix/data ${release}/data`,
    ]);
    assert.deepEqual(writable.split('\n').filter(line => line.startsWith('ReadWritePaths=')), [
      `ReadWritePaths=/opt/xflix/data ${release}/data`, `ReadWritePaths="${media}"`,
    ]);
    assert.equal(writable.replace(`ReadWritePaths="${media}"\n`, ''), readOnly);
  }
});

test('unit generation refuses path/directive injection even with an explicit write opt-in', () => {
  const release = '/opt/xflix-releases/20260905T120000Z-123';
  for (const media of ['/', '/opt', '/etc', '/root/photos', '/home/photos', '/opt/xflix/data', '/opt/xflix-releases/old', '/var/backups/media', '../media', '/mnt/../etc', '/srv//photos', '/srv/photos/%h', '/srv/photos" /etc "', '/srv/photos\\x20/etc', '/srv/photos\nUser=root']) {
    for (const flag of ['true', 'false']) {
      assert.throws(() => unit(release, { ...valid(), MEDIA_DIR: media, XFLIX_MEDIA_WRITE: flag }));
    }
  }
});

test('media path preflight rejects symlinks, non-directories and world-writable ancestors without writes', t => {
  const calls = [];
  let unsafe = '';
  let kind = '';
  t.mock.method(fs, 'lstatSync', file => {
    calls.push(file);
    return {
      isDirectory: () => file !== unsafe || kind !== 'file',
      isSymbolicLink: () => file === unsafe && kind === 'symlink',
      mode: file === unsafe && kind === 'writable' ? 0o777 : 0o755,
    };
  });
  checkMediaPath('/srv/My Photos');
  assert.deepEqual(calls, ['/srv', '/srv/My Photos']);
  for (unsafe of ['/srv', '/srv/My Photos']) {
    for (kind of ['file', 'symlink', 'writable']) assert.throws(() => checkMediaPath('/srv/My Photos'));
    for (kind of ['file', 'symlink']) assert.throws(() => checkMediaPath('/srv/My Photos', { readOnly: true }));
  }
});

test('world-writable media root is admitted only in explicit read-only mode, never its ancestors', t => {
  let writable = '/mnt/shared-media';
  t.mock.method(fs, 'lstatSync', file => ({
    isDirectory: () => true, isSymbolicLink: () => false,
    mode: file === writable ? 0o777 : 0o755, uid: 65534, gid: 65534,
  }));
  assert.doesNotThrow(() => checkMediaPath('/mnt/shared-media', { readOnly: true }));
  assert.throws(() => checkMediaPath('/mnt/shared-media'));
  for (const readOnly of [false, undefined, 'true', 1]) {
    assert.throws(() => checkMediaPath('/mnt/shared-media', { readOnly }));
  }
  writable = '/mnt';
  assert.throws(() => checkMediaPath('/mnt/shared-media', { readOnly: true }));
  writable = '/srv/shared';
  assert.throws(() => checkMediaPath('/srv/shared/media', { readOnly: true }));
});

test('media, unit and rollback preflights derive read-only access from their validated service config', () => {
  const release = '/opt/xflix-releases/20260905T120000Z-123';
  const backup = '/var/backups/xflix/20260905T120000Z-456';
  for (const flag of [undefined, 'false', 'true']) {
    const env = { ...valid(), MEDIA_DIR: '/mnt/shared-media' };
    if (flag !== undefined) env.XFLIX_MEDIA_WRITE = flag;
    const oldEnv = Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join('');
    const files = { [`${backup}/complete`]: 'complete', [`${backup}/previous-release`]: release,
      [`${backup}/.env`]: oldEnv, [`${release}/.env`]: oldEnv,
      [`${backup}/previous.service`]: unit(release, env) };
    for (const args of [['media', '/fixture/.env'], ['unit', release, '/fixture/.env'], ['rollback-check', backup]]) {
      let output = '';
      const context = vm.createContext({ module: { exports: {} }, args, files,
        // The outgoing configuration must not override the saved rollback policy.
        env: args[0] === 'rollback-check' ? { ...env, XFLIX_MEDIA_WRITE: flag === 'true' ? 'false' : 'true' } : env,
        process: { execPath: '/usr/bin/node', version: 'v24.20.0', stdout: { write: text => { output += text; } } },
        require: name => name === 'node:fs' ? { lstatSync: file => ({
          isDirectory: () => true, isSymbolicLink: () => false, mode: file === '/mnt/shared-media' ? 0o777 : 0o755,
        }) } : require(name),
      });
      // Only config/backup I/O is stubbed; main dispatch, policy and media validation are real.
      const code = read('scripts/install-config.cjs') + `
        config = () => env;
        trusted = () => ({ isDirectory: () => true, mode: 0o700 });
        readSecret = file => { if (!(file in files)) throw new Error('Unexpected fixture path'); return files[file]; };
        verifyRelease = () => {}; groupId = () => 991;
        main(args);`;
      if (flag === 'true') {
        assert.throws(() => vm.runInContext(code, context), /Unsafe media root/);
        assert.equal(output, '');
      } else {
        vm.runInContext(code, context);
        assert.equal(output, args[0] === 'unit' ? unit(release, env) : args[0] === 'rollback-check' ? release : '');
      }
    }
  }
});

test('installer and rollback use release config for media policy and never grant media permissions', () => {
  const install = read('install.sh');
  const helper = read('scripts/install-config.cjs');
  assert.match(install, /helper unit "\$RELEASE" "\$RELEASE\/\.env"/);
  assert.match(helper, /validateUnit\(readSecret\(path\.join\(args\[0\], 'previous.service'\)\), release, env\)/);
  assert.match(helper, /validateUnit\(text, match\[1\], config\(path\.join\(match\[1\], '\.env'\)\)\)/);
  assert.match(install, /if \[\[ \$\(helper media-write "\$CONFIG\/\.env"\) == true \]\]; then\s+runuser -u xflix -- test -w "\$MEDIA_DIR"/);
  assert.ok(install.indexOf('test -w "$MEDIA_DIR"') < install.indexOf('helper stop-policy'));
  for (const source of [install, read('scripts/rollback.sh')]) {
    assert.doesNotMatch(source, /\b(?:chmod|chown|setfacl)\b[^\n]*\$MEDIA_DIR|\bsetfacl\b/);
  }
});

test('shell syntax is checked without executing any installer or CI command', () => {
  for (const file of ['install.sh', 'scripts/install-prepare.sh', 'scripts/ci-validate.sh', 'scripts/rollback.sh']) {
    const result = spawnSync('bash', ['-n', path.join(root, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    assert.match(read(file), /umask 077/);
  }
});

test('installer ordering and privilege boundaries remain explicit', () => {
  const install = read('install.sh');
  const prepare = read('scripts/install-prepare.sh');
  const bootstrap = read('scripts/install-db.cjs');
  assert.doesNotMatch(install + prepare, /\bsource\b[^\n]*admin-creds|\bfuser\b|\bnvm\b|npm install|^\s*sudo\s|--lts/m);
  assert.match(prepare, /npm ci .*--ignore-scripts/);
  assert.match(install, /--property=User=xflix-build/);
  assert.match(install, /--property=KillMode=control-group/);
  assert.ok(install.indexOf('helper stop-policy') < install.indexOf('mariadb-dump --no-defaults'));
  assert.ok(install.indexOf('mariadb-dump --no-defaults') < install.indexOf('MIGRATIONS=true'));
  assert.ok(install.indexOf('MIGRATIONS=true') < install.indexOf('systemctl start xflix.service'));
  assert.match(install, /helper credentials .*\| systemd-run .*--pipe/);
  assert.match(install, /--property=User=xflix --property=Group=xflix/);
  assert.match(install, /BOOTSTRAP_STARTED.*systemctl stop "\$BOOTSTRAP_UNIT"/);
  assert.doesNotMatch(bootstrap, /\$\{.*ADMIN_|process\.argv|console\.log/);
  assert.match(bootstrap, /VALUES \(\?, \?, \?, \?\)/);
  assert.match(read('scripts/rollback.sh'), /--schema-compatible/);
  assert.doesNotMatch(read('scripts/rollback.sh'), /mariadb .*<|tar .*--extract/);
  assert.ok(read('scripts/rollback.sh').indexOf('mariadb-dump --no-defaults') < read('scripts/rollback.sh').indexOf('systemctl start xflix.service'));
});

test('CI and test images pin the same approved Node 24 patch', () => {
  const ciVersion = /node-version: (\d+\.\d+\.\d+)/.exec(read('.github/workflows/ci.yml'))?.[1];
  const testVersion = /^FROM node:(\d+\.\d+\.\d+)-bookworm$/m.exec(read('test/Dockerfile'))?.[1];
  assert.deepEqual([ciVersion, testVersion], ['24.20.0', '24.20.0']);
  checkNodeVersion(`v${ciVersion}`);
});

test('CI validates SQL and browser fixtures without deployment access', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.doesNotMatch(ci, /deploy|environment:|root@|\b(?:ssh|scp|sftp)\b|\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  assert.match(ci, /mariadb:\n\s+image: mariadb:10\.11/);
  assert.match(ci, /XFLIX_INTEGRATION: 1/);
  assert.match(ci, /DB_HOST: localhost/);
  assert.match(ci, /run: node scripts\/install-smoke\.cjs/);
  assert.match(ci, /run: npm run check --ignore-scripts/);
  assert.match(ci, /container: mcr\.microsoft\.com\/playwright:v1\.63\.0-noble/);
  assert.match(ci, /run: npm run test:browser/);
  const validation = read('scripts/ci-validate.sh');
  assert.match(validation, /\[\[ \$EUID != 0 \]\]/);
  assert.ok(validation.indexOf('npm ci ') < validation.indexOf('npm run check'));
  assert.ok(validation.indexOf('npm run check') < validation.indexOf('npm run audit'));
});

test('all installer Node helpers parse without running them', () => {
  for (const name of fs.readdirSync(path.join(root, 'scripts')).filter(name => name.endsWith('.cjs'))) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, 'scripts', name)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

test('HTTP health distinguishes JSON auth routing from SPA, redirects, failures and timeouts', async t => {
  let status = 401;
  let contentType = 'application/json; charset=utf-8';
  let body = '{"error":"Authentication required"}';
  let hang = false;
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/auth/me');
    assert.equal(request.headers.authorization, undefined);
    if (hang) return;
    response.writeHead(status, { 'content-type': contentType });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  await probe(port);
  for (const badStatus of [200, 302, 403, 500, 503]) { status = badStatus; await assert.rejects(probe(port)); }
  status = 401;
  contentType = 'text/html';
  await assert.rejects(probe(port));
  contentType = 'application/json';
  body = '<html>SPA</html>';
  await assert.rejects(probe(port));
  body = '{}';
  await assert.rejects(probe(port));
  body = 'x'.repeat(9000);
  await assert.rejects(probe(port));
  hang = true;
  await assert.rejects(probe(port, 20));
  await assert.rejects(probe('3000/path'));
});
