#!/usr/bin/env bash
set -euo pipefail
umask 022

tag=${1:-}
[[ $tag =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || {
	printf '%s\n' 'usage: scripts/build-release.sh vMAJOR.MINOR.PATCH' >&2
	exit 2
}
version=${tag#v}
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
package_version=$(cd "$repo_root" && node -p 'require("./package.json").version')
[[ $package_version == "$version" ]] || {
	printf 'tag version %s does not match package version %s\n' "$version" "$package_version" >&2
	exit 1
}

dist=$repo_root/dist
rm -rf -- "$dist"
mkdir -p -- "$dist"
git -C "$repo_root" archive --format=tar --prefix="xflix-$version/" HEAD |
	gzip -n >"$dist/xflix-$version.tar.gz"
(
	cd "$dist"
	sha256sum "xflix-$version.tar.gz" >"xflix-$version.tar.gz.sha256"
)
