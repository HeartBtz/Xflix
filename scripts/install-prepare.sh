#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID != 0 ]] || exit 1
cd -- "$1"
# PATH is fixed by the root-controlled installer, including its selected runtime.
npm ci --omit=dev --include=optional --ignore-scripts --no-audit --no-fund --cache "$1/.npm"
node scripts/install-smoke.cjs
