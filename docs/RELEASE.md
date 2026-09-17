# Release and Relay contract

GitLab runs `validate` and `browser` for merge request pipelines, the default
branch and exact SemVer tags (`vMAJOR.MINOR.PATCH`). A SemVer tag runs
`build-release` only after both jobs pass. The build refuses an unprotected tag
through `CI_COMMIT_REF_PROTECTED`, requires the tag to equal `package.json`, and
produces a checksummed source archive. The installed `/health` response reports
that same version as `{"status":"ok","version":"MAJOR.MINOR.PATCH"}`.

Protect `v*` in GitLab and allow only Maintainers to create those tags. Relay
must use `semver_tag`, require `validate`, `browser` and `build-release`, and
compare both health fields exactly.

The sanitized GitLab repository currently has no tags even though the source
version is 2.3.0. Before Relay can calculate a subsequent release, establish the
reviewed 2.3.0 commit as the protected `v2.3.0` baseline. Do not let Relay infer
`v0.0.1`; the release builder intentionally rejects any tag that differs from
`package.json`.

## Production deployment blocker

The pre-sanitization repository history contains an old command targeting
`root@192.168.1.108` with `deploy <commit>`. Later repository evidence records
that CT108 refused direct root SSH and had neither the deployment key nor the
`deploy` executable. That job was deliberately removed instead of bypassing
Teleport or creating an administrative CI identity. Its command is historical
evidence, not a valid receiver contract.

The repository therefore does not define `deploy-production`. Restore a manual
tag-only job only after a dedicated source-limited forced receiver exists and is
documented. It must consume the checksummed tag artifact, preserve installer
backup/rollback and non-root service controls, use strict host-key checking,
serialize with `resource_group: xflix-production`, target a protected
`production` environment, and expose an independently reachable health URL.
Never replace the receiver with an interactive root shell or arbitrary remote
command execution.

Until then, Relay may validate merge requests and build releases but production
deployment must remain blocked. Leave the project's Relay deployment
configuration unset: Relay requires a real manual production job and must not be
pointed at a placeholder.
