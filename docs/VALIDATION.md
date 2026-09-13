# Validation scope

Run tests against a disposable checkout, media tree and database. No installation,
host package upgrade, or remote access is required for the local fixtures. This
document describes commands and coverage, not the status of any installation.

## Unit and fixture checks

With a suitable development toolchain and non-root account (prefer Node 24 LTS):

```bash
npm ci --ignore-scripts --include=optional
npm run check
npm run audit -- --audit-level=high
```

`check` includes `npm test` and syntax checks. The default suite covers auth,
media/path/Range behavior, scanner phases/cancellation, maintenance failure
fixtures, installer parser/static/HTTP checks and frontend state. Installer
fixtures do not execute a production installation or prove systemd hardening on
a live host. Dependency audit is a point-in-time registry result.

The production installer and CI guard admit Node 22.x >=22.16.0 or 24.x >=24.0.0,
not EOL Node 20. npm 10/11 are accepted at those floors; npm 12 requires Node
22.x >=22.22.2 or 24.x >=24.15.0. The retained `package.json` engine floor `>=20.9`
and successful Node 20 fixture runs indicate development compatibility only,
not production support. No host toolchain upgrade is needed to test version
parsers against synthetic values.
Installer fixtures cover the fixed `/usr/local/lib/xflix-node` runtime versus
`/usr/bin`, executable/PATH injection refusal, preservation of a saved unit's
runtime/media policy, and legacy `xflix` home validation.
The production unit command checks its own executable and Node version; the
pure unit renderer remains testable under the workstation's Node 20. No fixture
installs a runtime, modifies accounts or runs install/rollback on the host.

`test/Dockerfile` targets a Node 24.20.0/FFmpeg test image running as `node`,
matching the Node patch targeted by the `validate` CI job.
After preparing the locked development dependencies, build from the project
root. The checkout/dependencies are copied under `/app`, not bind-mounted with
the host's private file permissions. `.dockerignore` excludes Git history,
secrets and persistent data. Never add production secrets to the build context.
This is a validation container, not a production image or installer test VM.

```bash
docker build -f test/Dockerfile -t xflix-validation:local .
docker run --rm --network none xflix-validation:local
```

This network-isolated command skips the opt-in SQL suite; use the separate
disposable database environment below for real SQL coverage.
FFmpeg packages belong in that container, not on the workstation solely to
satisfy tests. Record skips from the actual run: a missing-FFmpeg host run does
not prove the real video test passed. Avoid fixed pass counts across revisions.

## Real MariaDB integration

`test/integration.test.js` is opt-in and uses actual SQL/HTTP operations, not
the mocked pool used by other fixtures. Provision a fresh disposable MariaDB
database named `xflix_test_<unique_suffix>` and a test-only user with the schema
and data privileges needed by `initSchema`. Do not reuse a populated database.
The fixture mutates schema, accounts, sessions, media and related records; its
name/credential guards are safeguards, not a reason to use a production server.

```bash
XFLIX_INTEGRATION=1 \
DB_HOST=localhost \
DB_NAME=xflix_test_local_001 \
DB_USER=xflix_test \
DB_PASS=xflix-disposable-test-only \
npm run test:integration
```

The password above is a literal disposable test credential, never a production
secret. The accepted database-name pattern is `xflix_test_*` with lowercase
letters, digits and underscores in the suffix. The fixture accepts localhost,
127.0.0.1 or the CI service hostname `mariadb`. It creates temporary media/thumb
directories and sets test-only auth/media-write settings. Keep the DB lifecycle
disposable; a successful run does not leave a reusable empty fixture database.

Coverage includes schema upgrade/idempotence, first-user registration races,
password byte limits, global session revocation, concurrent single-use resets,
deleted-user access, admin mutation races, cross-process maintenance exclusion,
FK cascades, quarantine snapshots and transactional clear. The suite is skipped
without `XFLIX_INTEGRATION=1`; default `npm test` alone is not real DB evidence.

## Browser validation

`test/frontend-server.js` serves static fixture assets only; it does not import
the application or connect to MariaDB. `test/frontend.browser.js` exports a
Playwright page harness with intercepted API/media responses and blocked
non-local requests. It exercises desktop/mobile UI, navigation, error paths,
dialogs, stale responses and session expiry, not real decoding or a full backend.

The automated runner starts a fixture on a free loopback port, launches Chromium,
executes the assertions and cleans up on success, error or timeout:

```bash
npm run test:browser
```

It requires browser binaries and their OS libraries. To avoid installing system
libraries on the workstation, use the matching Playwright image, with the locked
development dependencies already present in the build context:

```bash
docker build -f test/browser.Dockerfile -t xflix-browser-validation:local .
docker run --rm --network none --shm-size=256m xflix-browser-validation:local
```

The separate `browser` CI job also runs as non-root `pwuser`. The manual command
`node test/frontend-server.js --serve 0` only serves assets, not assertions.
Supplement with a manual Chromium/Firefox pass for real media, Back/Forward,
fullscreen/PiP, keyboard focus, mobile layout and reverse-proxy/MFA behavior.

## Continuous integration

CI should reproduce the commands above with Node 24.20.0, FFmpeg, a disposable
MariaDB 10.11 service and the pinned Playwright image. Set
`XFLIX_INTEGRATION=1` only for the disposable SQL/HTTP suite. Give validation
jobs read-only repository permissions and no installation or remote
administration credentials. Record the revision, environment, suites executed,
failures, skips, and manual coverage rather than a permanent exact test count.
Neither green tests nor backup-file presence proves installation or
recoverability.
