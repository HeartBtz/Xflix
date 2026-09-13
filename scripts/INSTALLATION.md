# Installer and CI contract

This contract belongs to the installation scripts. Review and test changes in a
disposable systemd/MariaDB environment before using them on a real installation.
Do not grant passwordless sudo for this installer or arbitrary npm/node/git commands.

## Prerequisites and ownership

- Invoke the reviewed `/opt/xflix/install.sh` from a controlled root session.
  It installs a service as **xflix**, never as its caller. PM2/manual startup is
  deliberately no longer managed. Stop/migrate those processes separately.
- Preinstall supported Node LTS **22.x >=22.16.0** or **24.x >=24.0.0** (prefer
  **24.x**), compatible npm **10.x/11.x/12.x**, FFmpeg/ffprobe, MariaDB client,
  mariadb-dump, systemd/systemd-run, useradd, runuser and ordinary GNU tools.
  Prefer a separately preinstalled official Node **24.20.0** distribution in the
  fixed real directory `/usr/local/lib/xflix-node`. If both `bin/node` and `bin/npm`
  are executable there, install/rollback select them; otherwise they use
  `/usr/bin/node` and `/usr/bin/npm`. An unsafe or incompatible complete isolated
  runtime fails closed, without falling back. No environment/argument override
  permits an arbitrary runtime path. The isolated directory, ancestors and Node
  binary must not be symlinks; all resolved files must be root-controlled, not
  group/world writable and publicly readable/executable or traversable as needed.
  The official relative npm symlink is allowed only within that isolated tree.
  The system pair must resolve below `/usr`, without traversing `/root`.
  No apt, nvm, floating LTS download,
  global npm install, toolchain copying or sudoers change is performed by install.
  Node 20 is EOL in September 2026 and is refused for production installation and
  rollback, even though `package.json` retains `engines.node >=20.9` for development
  compatibility this revision. Existing host toolchains are not upgraded by
  these scripts or by local installer tests. The isolated runtime
  leaves the host's `/usr/bin` toolchain unchanged. Its fixed `bin` is prepended
  to the installer/build PATH so npm's env-node shebang and smoke tests use the
  same Node as bootstrap migrations, health checks and the generated service.
  Generated units allow only `/usr/bin/node` or
  `/usr/local/lib/xflix-node/bin/node` in ExecStart, with the matching fixed PATH.
- npm 10/11 are accepted with either admitted Node LTS floor. npm 12 has a higher
  Node requirement: **22.x >=22.22.2** or **24.x >=24.15.0**, following its published
  `engines.node` constraint. Node 24.20.0 meets that requirement. Both the installer
  and CI still execute `npm --version`, check its exit status and validate the
  resulting stable version against the Node runtime. Unknown majors, prereleases
  and incompatible pairs fail closed; no npm or Node upgrade is attempted.
- Source, scripts and all code ancestors must be root-owned, not group/world
  writable. Use a quiescent reviewed checkout; do not edit it during installation.
  Root itself and the installed toolchain are trusted. Local malicious root is
  outside this boundary. Do not execute this installer from a writable checkout.
- Dedicated, non-login `xflix` and `xflix-build` accounts are created if absent.
  New accounts use `/nonexistent` and `/usr/sbin/nologin`. The existing dedicated
  legacy `xflix` account may also retain `/opt/xflix` as its home, provided that
  code directory remains root-controlled and the home is not shared. No existing
  account home is changed; `xflix-build` must always use `/nonexistent`.
  Shared UID/GID identities/groups, supplementary groups, login shells or any
  other home fail closed. The build identity cannot read runtime secrets or backups. Its transient
  systemd service bounds descendant lifetime and denies privileged operations.
- `npm ci --ignore-scripts --include=optional --omit=dev` is the only production
  dependency installation path. There is no fallback or lockfile rewrite. The
  sharp native smoke test actually creates a PNG; a failed binary dependency
  aborts before service shutdown. Third-party code still executes as the isolated
  build user during that test, and as xflix at runtime, never as root.

## Persistent state

- `/etc/xflix/.env` is authoritative after the first import. An existing
  `/opt/xflix/.env` is copied byte-for-byte, never sourced or regenerated; the
  old copy is not deleted. Later source `.env` edits do not update the service.
  Environment changes require a new install/release, not just a restart.
- Secret files must be regular, single-link, root-owned files. `.env` may be
  root-only or group-readable by the dedicated xflix group (normally 0600 or
  0640). `.admin-creds` is root-only (0600). Unsafe permissions are refused rather
  than silently repaired. Symlinks are forbidden for config, source, service,
  backups and state. Only relative dependency links contained in a release are
  allowed; special files and hardlinks are rejected.
- `.env` supports one uppercase assignment per line, single/double quotes,
  comments and CRLF, following dotenv for this subset. Duplicate keys, multiline
  values, backtick quoting, embedded matching quote characters, control characters
  and runtime-control keys are rejected. Quote values containing `#`; an old
  unquoted `#` has dotenv's existing comment meaning, not a new password meaning.
- `.admin-creds` uses literal `ADMIN_EMAIL=value` and `ADMIN_PASS=value`; shell
  syntax, quotes, dollar signs and `#` are data, never evaluated. Existing files
  and existing admin passwords are preserved. An existing installation without
  this file does not get a replacement credential. Bootstrap uses stdin JSON and
  parameterized queries in a bounded, unprivileged transient service; it does not
  reset existing users. Bootstrap has a ten-minute ceiling, dependency preparation
  fifteen minutes; aborts can leave partially applied DDL, never an automatic
  schema rollback.
- Fresh configuration uses random hex passwords/secrets and `/mnt/media`. Create
  that media mount and make it readable/traversable by xflix first, or prepare a
  secure `.env`. Normalized non-system paths such as `/mnt/media` and `/srv/media`
  are supported (including spaces, no symlink ancestors).
  Paths under `/root` or `/home` require explicit migration out of home directories.
- Media is **read-only by default** in the service sandbox. The optional `.env`
  key `XFLIX_MEDIA_WRITE` accepts only the exact values `true` and `false`; absence
  means false. Empty values, 0/1, yes/no and mixed case are rejected. New configs
  include `XFLIX_MEDIA_WRITE=false`. Existing configs are still imported unchanged:
  no legacy installation is silently opted in, even if its media is writable on
  the host. Photo/video reads and scans remain available under non-root xflix with
  read/traverse permissions; thumbnails and database updates remain writable.
- A shared, world-writable media library (for example an NFS `/mnt/shared-media` mount
  presenting mode 0777 and nobody:nogroup in an unprivileged container) is accepted
  **only at the final MEDIA_DIR directory**, with `XFLIX_MEDIA_WRITE` absent or
  `false` and the service's read-only sandbox. Every ancestor must remain a
  non-world-writable directory; symlinks and non-directories are always refused,
  including at MEDIA_DIR. `XFLIX_MEDIA_WRITE=true` refuses a world-writable final
  directory to reduce destructive races. Install, unit generation and rollback
  preflights use their respective validated service configuration for this check.
  No NAS permissions, mount options or media-root path are changed automatically.
  Treat the library's content as untrusted: read-only access does not prevent
  other clients or NAS administrators from changing it and is not race isolation
  against those writers. This exception does not authorize media quarantines.
- To permit media mutations, explicitly set `XFLIX_MEDIA_WRITE=true` in the
  authoritative `/etc/xflix/.env` (or the source `.env` before first import), then
  perform a reviewed installation to regenerate the release and service. This adds
  only `ReadWritePaths="MEDIA_DIR"` for the actual validated absolute media path.
  Spaces are quoted as one path; traversal, system paths, systemd specifiers,
  control characters, quotes, backslashes and symlink ancestors are refused.
  All other sandbox protections, User=xflix and empty capabilities stay unchanged.
- The opt-in is a sandbox exception, **not** a permission grant. Existing xflix
  write access to MEDIA_DIR is checked before downtime when true. No media chmod,
  chown, ACL, supplementary group or mount-option change is made. The operator must
  separately provision appropriate filesystem access and a writable backing mount;
  per-file restrictions can still prevent a particular mutation. False/absent does
  not require write access, and changing the flag back to false requires another
  reviewed installation too, not just a restart of the old release.
- Admin deletion needs this opt-in even with `deleteFile:false`: its quarantine
  journal is written under `MEDIA_DIR/.xflix-trash`. The backend/UI handles an early
  explanatory denial when writes are disabled; that code is outside the installer.
  Media quarantine stays on the media filesystem; thumbnail quarantine belongs in
  `THUMB_DIR/.xflix-trash`, on the thumbnail filesystem. The installer does not
  create, move or purge those quarantines. Media and its quarantine are not part
  of the installer backup; the data backup includes the thumbnail quarantine.
- Persistent thumbnails/data stay at `/opt/xflix/data`, owned by xflix. Each
  immutable release has that directory bind-mounted at its own `data` path.
  The service also fixes `THUMB_DIR=/opt/xflix/data/thumbs` in its environment so
  stored absolute thumbnail paths do not change with each release. Use that same
  environment for any separately reviewed offline CLI operation.
  An explicit `THUMB_DIR` must be `/opt/xflix/data/thumbs`; move other locations
  offline before upgrading. Media itself is not copied or included in backups.
- Releases are `/opt/xflix-releases/TIMESTAMP-PID`, root-owned and immutable to
  both service and build accounts. The unit points directly to one release; there
  is no writable `current` link. The writable data mount is the default application
  filesystem exception, apart from private temporary storage; the only additional
  media exception requires `XFLIX_MEDIA_WRITE=true`.

## Database and maintenance

- Supported provisioning/backup is local MariaDB, TCP localhost/127.0.0.1:3306
  for the app and root Unix-socket authentication for administration. Remote DBs,
  custom sockets/ports and a password-based DB admin account require a separate
  reviewed workflow. No DB password appears in argv or interpolated Node code.
  MariaDB must already be running; the installer does not start or configure the
  database daemon.
- Existing database identity/password must match the running release. No ALTER
  USER or credential rotation is performed. Fresh provisioning fails on existing
  user collisions instead of taking over an account. SQL identifiers are bounded;
  password literals are quoted with an explicit no-backslash-escapes SQL mode and
  client commands disabled. SQL errors containing passwords are not printed.
- Fresh app grants are scoped to its database: SELECT, INSERT, UPDATE, DELETE,
  CREATE, ALTER, INDEX, REFERENCES and DROP. DDL remains necessary because the app
  migrates on bootstrap and startup. Runtime/migration DB identities are not split
  in this change; no global privileges or GRANT OPTION are added. Existing grants
  are not silently revoked or normalized.
- Dependencies are prepared before downtime. Then only the identified
  `/etc/systemd/system/xflix.service` is stopped. Unknown units/drop-ins and other
  xflix processes fail closed. A root-controlled runtime maintenance drop-in sets
  SIGTERM, control-group shutdown, 120 seconds, no automatic SIGKILL and no restart.
  The installer never kills a port owner. An occupied port aborts deployment.
- SIGTERM is a graceful-stop *request*. HTTP/FFmpeg draining depends on the app's
  own signal handlers; the installer cannot add that guarantee. A timeout or
  leftover process blocks migration. Stop external CLI jobs and all other DB/data
  writers before starting. The installer lock serializes these scripts, not every
  possible external writer or separately launched administrative command.
- Once stopped, `/var/backups/xflix/TIMESTAMP-PID` (0700) receives old config/unit,
  release identity, data tar and a non-empty MariaDB dump, before `initSchema`.
  Dump failure prevents migrations. `complete` is written only after backup (or
  fresh provisioning with no old schema). Partial output is not a usable backup.
  Single-transaction consistency assumes InnoDB and no external DDL/writers.
- A fresh DB/user creation is not transactional. A partial provisioning failure
  may leave a DB/user and requires manual review; the script does not drop either.
  Configuration and secrets survive retries. Data and DB backup availability is
  not evidence of restorability; test restoration separately on an isolated DB.
- The new service has no Linux capabilities, no root-home access, no new
  privileges, a read-only system and private devices/tmp. Start succeeds only if
  local `/auth/me` returns the expected unauthenticated JSON 401 and systemd is
  active. SPA HTML, redirects, 500 and connection errors fail the HTTP check.
  `node scripts/healthcheck.cjs 3000` is a local read-only probe, not an authenticated
  DB readiness, full feature, external proxy or backup-recoverability test.

## Failure and rollback

- Before maintenance starts, failure leaves the old service alone. After it
  starts, failure attempts to leave the service stopped and retains backups and
  releases. It does **not** automatically restart old code after possible schema
  changes. A failed graceful stop may still leave processes alive: inspect them.
- The maintenance drop-in can remain after failure and is recognized on retry;
  it is removed on successful unit replacement. It is in `/run` and does not
  survive reboot. Do not reboot to recover a failed upgrade: an old enabled unit,
  especially a legacy root unit, could start again. Review/disable it manually.
- For a previous release produced by this installer, after proving schema/data
  compatibility or restoring and verifying an appropriate backup offline:

  `bash /opt/xflix/scripts/rollback.sh TIMESTAMP-PID --schema-compatible`

- This restores the previous known non-root unit, code pointer and configuration,
  retains a rescue backup of outgoing config/DB/data, restarts, and checks HTTP
  plus systemd. A changed database identity/password blocks this path as well.
  Rollback reconstructs and validates the saved unit from its exact ExecStart,
  retaining the saved Node path and matching PATH, not the helper's current
  runtime selection. That saved Node/npm pair must still be present, trusted and
  version-compatible before shutdown; rollback never substitutes another runtime
  or restores toolchain binaries. In particular a saved `/usr/bin/node` unit is
  refused if that path is now Node 20, even if the isolated Node 24 is available.
  Startup migrations and the rollback HTTP check use the saved Node path.
  Check the previous application's compatibility with that runtime as well as
  schema/data compatibility before authorizing its restart.
  Unit validation uses the saved release's media-write flag and path, not the new
  config's policy. Rollback restores that explicit saved policy; a missing legacy
  flag remains read-only. Saved write opt-ins must still pass path/access checks.
  It does **not** restore SQL, thumbnails or media. Startup itself runs the old
  application's migrations, so the compatibility flag is a substantive operator
  assertion, not an automatic test or an authorization to downgrade any schema.
- First migration from the old in-place/root/PM2 installer has **no automated code
  rollback**. Its old unit is recorded but refused by rollback. A legacy checkout
  may already contain new files; its prior executable code is not reconstructible
  from memory. Retain a trusted old revision/artifact and take an independent
  pre-upgrade backup when moving from that layout.
- Existing admin credentials are restored when present in the selected backup;
  absence does not delete a newer credential file. Accounts, fresh DB grants,
  directory ownership, enablement and external configuration are not rolled back.
  Old releases/backups are not pruned automatically; plan capacity and retention.

## CI and release validation

- `.github/workflows/ci.yml` pins Node 24.20.0 for validation, installs FFmpeg,
  and starts a disposable MariaDB 10.11 service. `XFLIX_INTEGRATION=1` enables
  the real SQL/HTTP suite with test-only credentials.
- Validation installs the lockfile with lifecycle scripts disabled and runs the
  sharp smoke test and `npm run check`. The separate browser job uses the matching
  Playwright image and runs `npm run test:browser`. Run the production dependency
  audit separately so registry advisories remain visible and actionable.
- CI is validation-only and has read-only repository permissions. It contains no
  installation, release, remote access, or production credentials. Validate the
  exact revision and maintain an independent backup and rollback plan before any
  installation. A green workflow is not proof of deployment or recoverability.
