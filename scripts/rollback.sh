#!/usr/bin/env bash
# Deliberately does not restore SQL or data. Compatibility must be established offline.
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV CDPATH
die() {
	printf '%s\n' "$*" >&2
	exit 1
}
[[ $EUID == 0 && $# == 2 && $2 == --schema-compatible ]] || die 'Usage: bash scripts/rollback.sh BACKUP_ID --schema-compatible'
[[ $1 =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || die 'Invalid backup ID.'
SOURCE=/opt/xflix
BACKUP="/var/backups/xflix/$1"
UNIT=/etc/systemd/system/xflix.service
NODE=/usr/bin/node
NPM=/usr/bin/npm
if [[ -x /usr/local/lib/xflix-node/bin/node && -x /usr/local/lib/xflix-node/bin/npm ]]; then
	NODE=/usr/local/lib/xflix-node/bin/node
	NPM=/usr/local/lib/xflix-node/bin/npm
fi
[[ -x $NODE && -x $NPM ]] || die 'Missing preinstalled Node/npm runtime.'
for file in / /opt "$SOURCE" "$SOURCE/scripts" "$SOURCE/scripts/install-config.cjs" "$SOURCE/scripts/rollback.sh"; do
	[[ ! -L $file && $(stat -c %u "$file") == 0 ]] || die 'Untrusted rollback path.'
	(((8#$(stat -c %a "$file") & 0022) == 0)) || die 'Unsafe rollback permissions.'
done
if [[ $NODE == /usr/local/lib/xflix-node/bin/node ]]; then
	for file in /usr /usr/local /usr/local/lib /usr/local/lib/xflix-node /usr/local/lib/xflix-node/bin "$NODE"; do
		[[ ! -L $file && $(stat -c %u "$file") == 0 ]] || die 'Untrusted isolated runtime path.'
		(((8#$(stat -c %a "$file") & 0022) == 0)) || die 'Unsafe isolated runtime permissions.'
	done
	export PATH=/usr/local/lib/xflix-node/bin:$PATH
fi
helper() { "$NODE" "$SOURCE/scripts/install-config.cjs" "$@"; }
helper toolchain "$NODE" "$NPM"
helper trusted "$SOURCE/scripts/healthcheck.cjs"
helper trusted /run
[[ ! -L /run/xflix-install.lock ]] || die 'Symlink lock refused.'
if [[ -e /run/xflix-install.lock ]]; then helper root-secret /run/xflix-install.lock; fi
exec 9>/run/xflix-install.lock
flock -n 9 || die 'Another installer or rollback is running.'
helper account xflix
for command in mariadb-dump tar pgrep systemctl; do command -v "$command" >/dev/null || die 'Missing rollback prerequisite.'; done
RELEASE=$(helper rollback-check "$BACKUP")
ROLLBACK_NODE=$(helper managed-unit "$BACKUP/previous.service")
helper toolchain "$ROLLBACK_NODE" "${ROLLBACK_NODE%/*}/npm"
helper managed-unit "$UNIT" >/dev/null
[[ $(systemctl show -p FragmentPath --value xflix.service) == "$UNIT" ]] || die 'Unexpected service location.'
dropins=$(systemctl show -p DropInPaths --value xflix.service)
[[ -z $dropins || $dropins == /run/systemd/system/xflix.service.d/90-xflix-maintenance.conf ]] || die 'Unexpected drop-in.'
helper secret /etc/xflix/.env
helper same-db /etc/xflix/.env "$BACKUP/.env"
if [[ $(helper media-write "$BACKUP/.env") == true ]]; then
	MEDIA_DIR=$(helper media-path "$BACKUP/.env")
	runuser -u xflix -- test -w "$MEDIA_DIR" || die 'Saved XFLIX_MEDIA_WRITE=true requires existing xflix write access; provision permissions separately.'
fi
if [[ -e /etc/xflix/.admin-creds || -L /etc/xflix/.admin-creds ]]; then helper root-secret /etc/xflix/.admin-creds; fi
if [[ -e $BACKUP/.admin-creds || -L $BACKUP/.admin-creds ]]; then helper root-secret "$BACKUP/.admin-creds"; fi
STOPPED=false
cleanup() {
	local status=$?
	trap - EXIT
	if ((status != 0)) && $STOPPED; then
		systemctl stop xflix.service >/dev/null 2>&1 || true
		printf '%s\n' 'Rollback failed; keep service stopped and investigate. No SQL/data restoration was attempted.' >&2
	fi
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
helper stop-policy
systemctl daemon-reload
STOPPED=true
systemctl stop xflix.service
[[ $(systemctl show -p MainPID --value xflix.service) == 0 ]] || die 'Service did not stop.'
[[ $(systemctl show -p ControlGroup --value xflix.service) == '' ]] || die 'Workers remain in service cgroup.'
if pgrep -u xflix >/dev/null; then die 'Other xflix writers remain.'; fi
# Preserve the outgoing configuration; never overwrite an existing rescue snapshot.
RESCUE="/var/backups/xflix/rollback-$(date -u +%Y%m%dT%H%M%SZ)-$$"
helper private-dir /var/backups/xflix
mkdir -m 0700 "$RESCUE"
install -m 0600 /etc/xflix/.env "$RESCUE/.env"
install -m 0600 "$UNIT" "$RESCUE/xflix.service"
if [[ -e /etc/xflix/.admin-creds ]]; then install -m 0600 /etc/xflix/.admin-creds "$RESCUE/.admin-creds"; fi
# Old startup also runs migrations: preserve outgoing DB/data before attempting it.
DB_NAME=$(helper db-name /etc/xflix/.env)
mariadb-dump --no-defaults --user=root --protocol=socket --single-transaction --quick \
	--routines --events --triggers --hex-blob --databases "$DB_NAME" >"$RESCUE/database.sql.partial"
[[ -s $RESCUE/database.sql.partial ]] || die 'Empty rescue database backup.'
mv "$RESCUE/database.sql.partial" "$RESCUE/database.sql"
helper data /opt/xflix/data
tar --create --file "$RESCUE/data.tar" --directory /opt/xflix data
printf '%s\n' 'Rescue backup complete before rollback startup migrations.' >"$RESCUE/complete"
install -o root -g xflix -m 0640 "$BACKUP/.env" /etc/xflix/.env
if [[ -e $BACKUP/.admin-creds ]]; then install -m 0600 "$BACKUP/.admin-creds" /etc/xflix/.admin-creds; fi
install -m 0644 "$BACKUP/previous.service" "$UNIT"
helper clear-stop-policy
systemctl daemon-reload
systemctl start xflix.service
PORT=$(helper port /etc/xflix/.env)
"$ROLLBACK_NODE" "$SOURCE/scripts/healthcheck.cjs" "$PORT"
systemctl is-active --quiet xflix.service
STOPPED=false
printf 'Restored code/unit/config for %s; database and data unchanged. Rescue config: %s\n' "$RELEASE" "$RESCUE"
