# XFlix security review

This document describes the version 2.3 security model. The initial code audit is
preserved in [AUDIT.md](AUDIT.md). Neither document guarantees completed secret
rotation, backup recoverability, or a vulnerability-free application.

## Corrected in 2.3

- Media metadata, thumbnails, originals, streams and downloads require an
  authenticated session by default (`REQUIRE_AUTH=true`).
- Session JWTs use an explicit algorithm, issuer, audience and numeric subject.
  They are delivered in host-only `HttpOnly; SameSite=Strict` cookies. Tokens in
  query strings are rejected. All legacy cookies/Bearer tokens without the `sv`
  claim are invalidated; there is no legacy-session migration or renewal by
  `/auth/me`. A current-format Bearer token must pass the same version check.
- Each authenticated request checks the current DB user and `session_version`.
  Logout advances that version (`sv++`), invalidating all sessions issued for
  the previous version, not just the current browser. Password change/reset and
  actual role changes also advance it; deleted accounts cannot authenticate.
  DB authentication outages fail closed with 503. A failed logout must be retried,
  not reported as successful revocation. Already-authorized in-flight work is
  not retroactively cancelled by changing a version.
- Unsafe requests reject cross-site browser origins. CORS is same-origin unless
  an explicit allow-list is configured.
- Content Security Policy permits only same-origin JavaScript and prevents
  framing, plugins and foreign base/form targets. Dynamic inline event handlers
  were removed.
- Password-reset tokens are SHA-256 hashed in MariaDB, expire after one hour and
  are never written to logs. `BASE_URL` is validated instead of trusting the
  request Host header.
- Reset consumption, password replacement, token clearing and version increment
  occur in one conditional SQL update. Password changes compare the old hash
  and session version to prevent stale writes and also clear outstanding resets.
- SMTP certificates are verified by default.
- Registration and admin account mutations share a DB-scoped lock/transaction.
  Public first-admin bootstrap requires an empty user table and allowed
  registration. An existing table without an admin is not a bootstrap opportunity.
  Self-removal of admin access and removal of the last admin are refused; the
  actor is rechecked inside the transaction.
- New passwords (register/change/reset) use bcrypt cost 12, require at least 12
  characters and reject input beyond 72 UTF-8 bytes rather than silently
  truncating it. Login/current-password checks retain the legacy 128-character
  input ceiling so old accounts can authenticate and change their passwords.
  This compatibility does not remove bcrypt's historical truncation behavior
  from existing hashes. Profiles have server-side validation.
- Byte ranges are validated and invalid ranges return HTTP 416.
- Protected media use private browser caching rather than shared public caching.
- Media paths are checked against canonical roots. Destructive operations reject
  symlinks below those roots; duplicate removal verifies full-file SHA-256 and an
  independent surviving file. Thumbnail output is staged before publication.
- Cooperating scanner/CLI/admin jobs share a MariaDB maintenance lock. Bounded
  media deletion snapshots related rows and journals same-filesystem quarantine
  moves before committing SQL. Missing-row removal additionally requires an
  explicit opt-in and storage sentinel. See [recovery](docs/MAINTENANCE-RECOVERY.md).
- The installer generates a dedicated non-root systemd service with restrictive
  umask, empty capabilities and filesystem hardening. Media is read-only unless
  explicitly opted in; dependency preparation uses a separate build identity.
  This contract is a major change, not an automatic migration of every old
  root/PM2 service. See [installation](scripts/INSTALLATION.md).
- Production startup fails when `JWT_SECRET` is absent or shorter than 32
  characters. `npm audit` is part of the documented verification workflow.

## Remaining risks and recommended follow-up

- There is no MFA. Put the application behind an identity-aware reverse proxy
  with MFA if it is reachable from the public Internet.
- Path validation is not a filesystem sandbox against a hostile local actor who
  can replace directories, symlinks or hardlinks between checks and use. The
  application lock does not constrain external filesystem/DB writers. Restrict
  local access, use the service sandbox and quiesce external writers before
  maintenance. Do not claim all link/race attacks are eliminated.
- `XFLIX_MEDIA_WRITE=false` is the default. Exact `true` plus a regenerated service
  and actual filesystem permissions are required for media removal, including
  `deleteFile:false`, because the media quarantine journal must be writable.
  This flag is not an ACL grant or an independent backup policy.
- Quarantines and journals are recovery evidence, not automatic restoration.
  Ambiguous commits/rename failures can require manual reconciliation; there is
  no automatic crash-recovery restorer or quarantine deletion/retention policy.
  Protect journals: their snapshots include paths, metadata and social content.
- Schema DDL remains startup/bootstrap-driven and is not automatically rolled
  back. Runtime and migration DB identities are not split. Code rollback requires
  proven compatibility or a separately restored and verified offline backup.
  Installer tar/dump files do not include media and are not proof of restoration.
- Historical `.admin-creds` exposure has not been remediated by a documented
  rotation in this change. The installer preserves existing credentials rather
  than rotating them. Review exposure and rotate affected secrets separately;
  do not assume current file permissions remove copies from history or backups.
- SMTP credentials are stored in the application database. Restrict MariaDB and
  backup access and prefer a dedicated, least-privilege SMTP credential.
- Login rate limiting is in-memory and per process. A multi-instance deployment
  needs a shared limiter or enforcement at the reverse proxy.
- Unit/HTTP fixtures, opt-in real MariaDB integration, and Playwright UI fixtures
  exist. Browser API/media responses are intercepted, not a full production stack
  test. Fullscreen/PiP, proxy/MFA, and real media need release-specific validation.
- CI is validation-only, uses disposable services, and has read-only repository
  permissions. It has no production secrets or remote administration steps. CI
  success is not proof that an installation is secure or recoverable.

## Before exposing XFlix

1. Use HTTPS only and set `BASE_URL=https://...`.
2. Keep `REQUIRE_AUTH=true`; leave `CORS_ORIGIN` empty unless required.
3. Generate a unique `JWT_SECRET` of at least 32 random bytes. Protect authoritative
   `/etc/xflix/.env` as required by the installer (root-owned, normally 0600 or
   dedicated-group 0640); keep `.admin-creds` root-only 0600. Review historical
   secret exposure separately.
4. Configure `TRUST_PROXY` for the exact reverse-proxy topology and verify that
   the session cookie has the `Secure` attribute.
5. Close registration in Admin, use a unique administrator password and place
   MFA in front of the site.
6. Restrict the firewall so port 3000 is reachable only by the reverse proxy.
7. Follow [validation](docs/VALIDATION.md): unit/check, production dependency audit,
   isolated MariaDB integration, browser fixtures and a manual release pass.
8. Confirm unauthenticated requests to `/api/stats`, `/thumb/1` and `/stream/1`
   return HTTP 401.
9. Verify the actual non-root service, media-write policy, storage mounts and
   sentinel configuration. Rehearse backup restoration in isolation before
   maintenance; retain journals and stop on ambiguous results.

Report security issues privately to the repository owner; do not include real
tokens, credentials, media paths or personal data in a public issue.
