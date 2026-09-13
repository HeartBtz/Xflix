# XFlix 2.3 code audit

Audit date: 2026-08-11. Scope: Express backend, MariaDB access, scanner,
streaming, authentication, admin operations, vanilla-JS SPA, installer and npm
dependency tree.

The table below records the initial audit baseline and the corresponding code
changes. Verify the current revision and dependencies independently.

## Initial audit baseline (2026-08-11)

| Priority | Finding | Resolution |
|---|---|---|
| Critical | API metadata and original media were publicly accessible | Authentication is required by default for API, thumbnails, streams, photos and downloads |
| High | Browser Back changed the page behind an open/fullscreen viewer | Page and media overlays now share one normalized History state; Back tears down fullscreen/PiP and closes the viewer first |
| High | JWT stored in localStorage and accepted in query strings | Host-only HttpOnly cookie; one-time legacy Bearer migration; query authentication removed |
| High | CSP disabled while user-controlled names entered inline JavaScript handlers | Event delegation replaces inline handlers; same-origin script CSP enabled |
| High | Password-reset URL/token logged and token stored directly in MariaDB | No token logging; validated `BASE_URL`; SHA-256 token at rest |
| High | SMTP accepted any TLS certificate | Certificate validation enabled by default |
| High | npm tree contained vulnerable packages | Packages refreshed; zero vulnerabilities were reported at the initial audit, not asserted for future registry results |
| High | Duplicate detection hashed only the first 64 KiB | Full-file SHA-256 verification before files are grouped |
| Medium | Concurrent first registrations could both gain admin assumptions | Registration serialized with a MariaDB named lock |
| Medium | CORS reflected arbitrary origins and proxy trust was overly broad | Same-origin default, explicit allow-list, loopback proxy default |
| Medium | Invalid HTTP byte ranges generated malformed streams | Strict parser and HTTP 416 response |
| Medium | Protected media were marked publicly cacheable | Private cache policy when authentication is enabled |
| Medium | SQL foreign-key checks could be changed on a different pooled connection | Clear operation uses one acquired connection and always restores checks |
| Medium | Empty auto-tags did not clear stale mappings | Tag replacement now always removes the old mapping first |
| Medium | Pagination/search inputs accepted negative, fractional or unbounded values | Bounded integer and search-length validation |
| Medium | Personal player favourite buttons changed the shared global flag | Player and lightbox now use each user's personal favourites; global mutation is admin-only |
| Low | Abandoned `fluent-ffmpeg` dependency | Direct, argument-safe `ffmpeg` and `ffprobe` child processes with timeouts |

## Current code safeguards

These entries supersede the corresponding baseline descriptions. Evidence is
the current source and test fixtures. Test counts are deliberately omitted
because validation evolves and FFmpeg availability changes executed/skip scope.

| Area | Current code contract | Remaining boundary |
|---|---|---|
| Sessions | JWT `sv` must match DB `session_version`; logout, password changes/resets and role changes revoke prior versions; deleted users are rejected | All legacy sessions without `sv` are invalidated, not migrated; in-flight work is not retroactively revoked |
| Passwords/reset | New register/change/reset passwords use bcrypt cost 12, minimum 12 characters and maximum 72 UTF-8 bytes; reset consumption/password/version update is atomic | Legacy login/current-password ceiling of 128 characters is retained, including existing bcrypt truncation behavior |
| Account management | Registration/admin mutations serialize; public bootstrap requires an empty user table; actor/last-admin checks run inside the transaction | Existing accounts without an admin require operator recovery, not public takeover; no native MFA |
| Paths and thumbnails | Canonical-root checks, rejection of destructive symlink paths, regular-file checks and staged thumbnail publication | Not a sandbox against a hostile local writer swapping links/directories between checks |
| Maintenance | Shared DB lock across cooperating CLI/HTTP jobs; full-hash duplicate survivor checks; bounded transactional row deletion with snapshots and quarantine journals | External writers are not locked out; uncertain filesystem/SQL outcomes require manual inspection |
| Cleanup | Missing-row removal requires opt-in plus a verified storage sentinel; unindexed originals are reported, not deleted; orphan thumbnails have their own quarantine | No automatic restoration or quarantine retention/deletion policy; missing mounts are not evidence of deleted files |
| Scanner/clear | Scan holds its lock through enrichment/thumbnails and drains started work on cancellation; DB clear uses transactional DELETE with FK checks enabled and `clear --confirm` | Committed scan batches are not undone; no persistent restart-resumable job queue |
| Path identity | Binary no-pad collation distinguishes Linux case, accents and trailing spaces without rebuilding media IDs | DDL remains startup/bootstrap-driven, with no automatic schema rollback |
| Frontend | Stale-response guards, error-aware mutations, session-expiry handling, accessible dialog/card controls and incremental SSE parsing have regression fixtures | Intercepted browser API/media fixtures do not prove full-stack playback, all browser behavior or production accessibility |
| Favorites | Personal favorites and separately labeled admin-only global controls have distinct endpoints | The baseline statement about player controls should not be read as removing all global controls |
| Installer | Node 22.x >=22.16.0 or 24.x >=24.0.0 with compatible npm 10/11/12; fixed isolated `/usr/local/lib/xflix-node` preferred over `/usr/bin`; preinstalled local MariaDB and FFmpeg; immutable releases, non-root identities, authoritative `/etc/xflix/.env` | Host toolchain unchanged; rollback preserves the saved approved Node path; existing credentials and a dedicated legacy xflix home are preserved |
| Media-write policy | Default `XFLIX_MEDIA_WRITE=false`; explicit `true` and filesystem access required even for `deleteFile:false` media journals | No automatic permission changes; setting the flag requires a reviewed release/service regeneration |
| Validation | Reproducible checks support disposable MariaDB and browser fixtures | Automated tests are not proof of an installation or backup recovery |

See [installation](scripts/INSTALLATION.md), [maintenance recovery](docs/MAINTENANCE-RECOVERY.md)
and [validation](docs/VALIDATION.md) for the operational contracts. Installer
backup tar/dump existence is not recoverability evidence; media is excluded.
Historical `.admin-creds` exposure/rotation is not closed by this documentation.

## Architecture assessment

The application is pleasantly small and deployable: there is no build chain,
SQL values are parameterized, sort fields use allow-lists, thumbnail generation
is deduplicated and bounded, and destructive admin operations are separated
behind an admin router. MariaDB schema creation is idempotent and the scanner
batch-inserts new media.

The main maintainability constraint is `public/js/app.js`, which owns routing,
authentication, rendering, player controls and social features in one file.
The new `navigation-state.js` isolates the pure History model, but further work
should split API/session, router, player, gallery and account UI into native ES
modules. `routes/admin.js` should likewise be divided by users, scan, cleanup
and duplicate-management domains.

## Remaining roadmap

1. Verify the session-version migration and forced legacy re-login on a disposable
   upgraded database, then assess deployed state separately.
2. Add MFA at the identity-aware reverse-proxy layer before
   public exposure.
3. Execute the automated browser/MariaDB validation in CI;
   supplement intercepted fixtures with manual real-media, Chromium/Firefox,
   fullscreen/PiP and reverse-proxy checks.
4. Move schema changes to numbered migrations and rehearse offline restoration.
   Current code rollback is conditional, not an automatic SQL downgrade.
5. Extend the media journal into a broader protected audit trail, including role
   changes. Current disk/DB snapshots are neither tamper-proof nor a complete
   admin audit log; document and test manual reconciliation and retention.
6. For very large libraries, move scan/thumbnail jobs to a small persistent
   queue so a process restart can resume work and multiple UI clients do not
   control one in-memory job.
7. Consider cursor pagination and indexed random sampling if `ORDER BY RAND()`
   becomes visible in query profiling.

See `SECURITY.md` for the Internet deployment checklist and residual risks,
including local link races, secret rotation and operator rollout verification.
