#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID != 0 ]] || {
	printf '%s\n' 'npm validation must not run as root.' >&2
	exit 1
}
node -e 'require("./scripts/install-config.cjs").checkNodeVersion(process.version)'
NPM_VERSION=$(npm --version)
node -e 'require("./scripts/install-config.cjs").checkNpmVersion(process.argv[1], process.version)' "$NPM_VERSION"
ffmpeg -version >/dev/null
ffprobe -version >/dev/null
npm ci --include=optional --ignore-scripts --no-audit --no-fund
node scripts/install-smoke.cjs
npm run check --ignore-scripts
npm run audit --ignore-scripts -- --audit-level=high
