# Maintenance and manual recovery

This guide describes the current `lib/admin-media.js`, `lib/maintenance.js` and
`routes/admin.js` contract. It is an inspection/reconciliation procedure, not an
automatic restorer, authorization to delete quarantine contents, or proof of
production recoverability. Do not replay requests after an ambiguous result.

## Before maintenance

- Keep external filesystem/DB writers stopped or otherwise quiescent. The
  database maintenance lock serializes cooperating XFlix CLI/HTTP jobs only;
  it cannot constrain a local process changing directories, links or files.
- Validate media/thumbnail mounts, capacity and access as the dedicated service
  user. Use independently tested backups. Never interpret an empty mountpoint
  or a storage I/O error as proof that indexed originals have been deleted.
- Media writes default to disabled. For an installer-managed service, explicitly
  set `XFLIX_MEDIA_WRITE=true` in authoritative `/etc/xflix/.env` and follow the
  [installer contract](../scripts/INSTALLATION.md) to regenerate the release and
  sandbox. Actual filesystem write permissions and a writable mount are also
  necessary. The installer does not change media permissions or grant ACLs.
- This opt-in is required even for `deleteFile:false`: removing DB rows writes a
  journal in `MEDIA_DIR/.xflix-trash`. `false` leaves originals in place; it does
  not make media-row removal a journal-free/read-only operation. A later scan
  can reindex those originals without recreating their old social records.
- Missing-file row cleanup also needs exact `XFLIX_ALLOW_MISSING_CLEANUP=true`,
  `XFLIX_STORAGE_SENTINEL` pointing inside the real media root and a nonempty
  `XFLIX_STORAGE_SENTINEL_VALUE`. The sentinel must be a regular file on the same
  device, at most 4096 bytes, with trimmed contents matching the expected value.
  Provision it deliberately on the intended storage, not on a missing mount's
  fallback directory. The parent of each missing file must exist, be readable
  and be on the same device. A configured sentinel is checked by storage probes
  even outside missing cleanup. It is evidence of storage identity, not a backup.

Cleanup and short-video purge default to `dry_run:true`. Single/bulk explicit
deletion defaults to live execution unless `dry_run:true` is supplied. Deletion
requires a JSON `deleteFile` boolean; strings and the old `delete_file` query
parameter are refused. Batches are bounded to 500 distinct positive integer IDs.
Dry-run deletion responses do not perform every live eligibility/write check.
Cleanup inventories unindexed files but does not delete those originals.

Duplicate deletion rehashes complete files and requires an independent surviving
copy outside the selection; another link to the same inode is not sufficient.
Checks reduce risk but do not eliminate link/directory swap races from a hostile
local actor. They are not a substitute for filesystem access control/sandboxing.

## Evidence locations

Media operations create `MEDIA_DIR/.xflix-trash/<operation_id>/journal.jsonl`.
With `deleteFile:true`, originals are renamed on the same filesystem to
`<id>.media` inside that operation directory. No cross-device copy/delete
fallback or automatic quarantine purge is provided. Scans skip the media
quarantine; after committed row deletion the old media ID is no longer available
through normal media routes. Do not treat this as an independent filesystem
access-control boundary or insert quarantine paths into live media rows.

The `prepared` snapshot contains media rows plus related comments, reactions,
personal favorites, media-tag mappings, performers and tags. It records actor,
reason, original paths and `delete_file`. It is sensitive application data.
Protect access to both journal copies and any diagnostic exports.

MariaDB table `admin_media_journal` stores `operation_id`, `actor_id`,
`created_at` and a JSON `payload` snapshot in the same transaction as the media
DELETE and performer count/cover updates. The final payload includes recorded
moves. The earlier disk `prepared` snapshot can have an empty `moves` array:
read subsequent disk `move-intent` and `commit-intent` records too.

Orphan thumbnails are separate operations under
`THUMB_DIR/.xflix-trash/<operation_id>/journal.jsonl` on the thumbnail filesystem.
They record `thumbnail-move-intent` then `committed`, not a media SQL snapshot.
Deleting media rows does not immediately remove their thumbnails; later cleanup
can quarantine them. Media-row cleanup and thumbnail moves are not one atomic
transaction and a cleanup request can finish partially.

## Interpret journal states

| Disk state | Evidence and limits |
|---|---|
| `prepared` | Initial row snapshot has been appended and synced before planned moves. Alone it does not establish the final file or DB state. |
| `move-intent` | Records source, quarantine destination, size, SHA-256 and optional survivor before rename. It is not proof that rename succeeded; inspect both paths. |
| `commit-intent` | SQL delete/journal work has been staged and a commit is about to be attempted. The final DB outcome may be unknown after a crash/disconnect. |
| `committed` | For media removal, the process observed SQL commit success and appended this marker; for a thumbnail-only operation, it records rename/sync completion. Check actual files and, for media removal, the SQL journal too. |
| `rolled-back` | Pre-commit SQL rollback and known-move compensation completed without recorded uncertainty. Quarantine links/journals are retained; do not assume they can be purged. |
| `recovery-required` | Commit, rollback, rename or compensation was uncertain/failed; preserve all evidence and reconcile manually. |
| `committed-journal-error` | SQL commit was observed but post-commit disk journaling failed; an HTTP/SSE error does not mean zero rows were deleted. |
| `thumbnail-move-intent` | Separate thumbnail rename intent; inspect both paths if no final marker exists. No `admin_media_journal` row is expected for this thumbnail-only operation. |

Disk appends and relevant directories are synced, but SQL and filesystem changes
are not a single distributed transaction. A crash can leave only a prefix of the
journal or a partial last line. Do not infer a safe outcome from a missing final
marker, an empty operation directory or an absent client success response.

On a known pre-commit failure, the running operation attempts SQL rollback and
exclusive hardlink compensation for known moves. It does not overwrite a
recreated destination and retains quarantine links. Once commit has been
attempted, rollback fails, or rename/compensation is uncertain, automatic
compensation cannot establish a safe final state. This limited in-process
compensation is not a restart-time journal replay or general recovery service.

## Inspect an ambiguous result

1. Stop issuing mutations and quiesce service/CLI/external writers through the
   approved operational path. Record the exact `operation_id`, endpoint, time,
   HTTP/SSE result, `deleted`, `deleted_db`, `deleted_thumbs`, `partial`,
   `recovery_required` and compensation errors. `deleted:null` means unknown,
   not zero. `staged` progress and a disconnected SSE stream are not success.
2. Preserve the disk journals, operation directories and a consistent DB snapshot
   before repair. Inspect mount identity, space, permissions and storage errors.
   Do not move/delete the only evidence or print private snapshots into CI logs.
3. Read every journal record for the operation. Inspect source and quarantine
   paths as regular files, including device/inode, size and recorded SHA-256.
   Never overwrite an existing source; it may be recreated data or a compensated
   hardlink. For duplicate removal inspect the recorded survivor too.
4. Query `admin_media_journal` by the exact operation ID on the authoritative DB,
   and inspect affected media/related rows and performer counts/cover references.
   The SQL journal row normally commits with deletion, but an absent row alone
   is insufficient evidence after DB restoration, external writes or storage
   failure. Compare DB state, disk state and both snapshots together.
5. Decide the intended outcome manually. Rehearse any restoration on an isolated
   copy: reconcile original IDs, foreign keys, comments, reactions, favorites,
   tag mappings and counts/covers without overwriting unrelated newer changes.
   A rescan is not a substitute for restoring relational/social data.
6. Apply only a separately reviewed repair, then verify file hashes, DB relations,
   counts/covers and authenticated media/thumbnail access before resuming writers.
   Preserve the evidence and repair record. There is no supplied automatic
   restorer, automatic purge or retention/deletion policy in this change.

The installer's backup tar includes persistent data/thumbnail quarantine, not
media or media quarantine. A nonempty SQL dump and a `complete` marker indicate
backup workflow completion, not proven restore success. Schema rollback is not
automatic, and code rollback restores neither SQL nor thumbnails/media. Follow
the [installation contract](../scripts/INSTALLATION.md) and test restoration on
an isolated database/filesystem before relying on these artifacts.
