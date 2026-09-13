#!/usr/bin/env bash
# Local, root-controlled installation only. See scripts/INSTALLATION.md.
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV CDPATH

die() {
	printf '%s\n' "$*" >&2
	exit 1
}
[[ $EUID == 0 ]] || die 'Run from a reviewed root session; no sudo policy is installed.'
[[ $# == 0 ]] || die 'Usage: bash /opt/xflix/install.sh (configure prerequisites first)'
SOURCE=/opt/xflix
RELEASES=/opt/xflix-releases
CONFIG=/etc/xflix
BACKUPS=/var/backups/xflix
UNIT=/etc/systemd/system/xflix.service
NODE=/usr/bin/node
NPM=/usr/bin/npm
if [[ -x /usr/local/lib/xflix-node/bin/node && -x /usr/local/lib/xflix-node/bin/npm ]]; then
	NODE=/usr/local/lib/xflix-node/bin/node
	NPM=/usr/local/lib/xflix-node/bin/npm
fi
[[ $(realpath -e -- "${BASH_SOURCE[0]}") == "$SOURCE/install.sh" ]] || die 'Use the reviewed /opt/xflix checkout.'
[[ -x $NODE && -x $NPM ]] || die 'Preinstall Node 22.x >=22.16.0 or 24.x >=24.0.0 and npm 10/11/12 in /usr/local/lib/xflix-node/bin or /usr/bin; no toolchain download.'
for cmd in runuser useradd getent install flock mariadb mariadb-dump systemctl systemd-analyze systemd-run pgrep tar cp ffmpeg ffprobe; do
	command -v "$cmd" >/dev/null || die "Missing prerequisite: $cmd"
done

# Check parents before invoking any repository helper with privileges.
for file in / /opt "$SOURCE" "$SOURCE/scripts" "$SOURCE/scripts/install-config.cjs" "$SOURCE/install.sh"; do
	[[ ! -L $file && $(stat -c %u "$file") == 0 ]] || die 'Untrusted installer path.'
	(((8#$(stat -c %a "$file") & 0022) == 0)) || die 'Installer path is group/world writable.'
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
helper trusted /etc/systemd/system
if [[ -e $UNIT || -L $UNIT ]]; then helper regular "$UNIT"; fi
for dir in /etc /var /var/backups /run /opt; do helper trusted "$dir"; done
for dir in "$CONFIG" "$BACKUPS" "$RELEASES"; do
	if [[ -e $dir || -L $dir ]]; then helper trusted "$dir"; else install -d -m 0700 "$dir"; fi
done
helper private-dir "$BACKUPS"
# /run is root-owned; unlike /run/lock it is not group/world writable on Debian.
[[ ! -L /run/xflix-install.lock ]] || die 'Symlink lock refused.'
if [[ -e /run/xflix-install.lock ]]; then helper root-secret /run/xflix-install.lock; fi
exec 9>/run/xflix-install.lock
flock -n 9 || die 'Another installer or rollback is running.'

# These two identities must be dedicated, without supplementary groups or login.
for account in xflix xflix-build; do
	if ! getent passwd "$account" >/dev/null; then
		useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$account"
	fi
	helper account "$account"
done
[[ $(id -u xflix) != "$(id -u xflix-build)" && $(id -g xflix) != "$(id -g xflix-build)" ]] || die 'Build/runtime accounts must be distinct.'
if pgrep -u xflix-build >/dev/null; then die 'Build account already has processes.'; fi
chmod 0755 "$RELEASES"
chown root:xflix "$CONFIG"
chmod 0750 "$CONFIG"
for file in "$CONFIG/.env" "$CONFIG/.admin-creds" "$SOURCE/.env" "$SOURCE/.admin-creds"; do
	if [[ -e $file || -L $file ]]; then
		if [[ $file == */.admin-creds ]]; then helper root-secret "$file"; else helper secret "$file"; fi
	fi
done

OLD_RELEASE=''
WAS_ACTIVE=false
if systemctl cat xflix.service >/dev/null 2>&1; then
	[[ $(systemctl show -p FragmentPath --value xflix.service) == "$UNIT" ]] || die 'Unexpected unit location.'
	dropins=$(systemctl show -p DropInPaths --value xflix.service)
	[[ -z $dropins || $dropins == /run/systemd/system/xflix.service.d/90-xflix-maintenance.conf ]] || die 'Review/remove service drop-ins before installation.'
	helper trusted "$UNIT"
	OLD_RELEASE=$(systemctl show -p WorkingDirectory --value xflix.service)
	helper old-release "$OLD_RELEASE"
	systemctl show -p ExecStart --value xflix.service | helper identify-exec "$OLD_RELEASE"
	if systemctl is-active --quiet xflix.service; then WAS_ACTIVE=true; fi
fi

if [[ ! -e $CONFIG/.env && ! -e $SOURCE/.env ]]; then
	[[ -z $OLD_RELEASE ]] || die 'Existing service without configuration; restore .env first.'
fi
helper configure "$SOURCE" "$CONFIG"
chown root:xflix "$CONFIG/.env"
chmod 0640 "$CONFIG/.env"
helper validate "$CONFIG/.env"
helper media "$CONFIG/.env"
MEDIA_DIR=$(helper media-path "$CONFIG/.env")
runuser -u xflix -- test -r "$MEDIA_DIR"
runuser -u xflix -- test -x "$MEDIA_DIR"
if [[ $(helper media-write "$CONFIG/.env") == true ]]; then
	runuser -u xflix -- test -w "$MEDIA_DIR" || die 'XFLIX_MEDIA_WRITE=true requires existing xflix write access to MEDIA_DIR; provision permissions separately.'
fi
if [[ -n $OLD_RELEASE ]]; then helper same-db "$OLD_RELEASE/.env" "$CONFIG/.env"; fi
DB_EXISTS=$(helper exists-sql "$CONFIG/.env" | mariadb --no-defaults --user=root --protocol=socket --batch --skip-column-names)
[[ $DB_EXISTS == 0 || $DB_EXISTS == 1 ]] || die 'Cannot determine database state.'
[[ -z $OLD_RELEASE || $DB_EXISTS == 1 ]] || die 'Existing service database missing; restore it first.'

ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
STAGE=$(mktemp -d /opt/xflix-build.XXXXXXXX)
RELEASE="$RELEASES/$ID"
BACKUP="$BACKUPS/$ID"
STOPPED=false
MIGRATIONS=false
BUILD_UNIT="xflix-build-$ID"
BUILD_STARTED=false
BOOTSTRAP_UNIT="xflix-bootstrap-$ID"
BOOTSTRAP_STARTED=false
cleanup() {
	local status=$?
	trap - EXIT
	if $BUILD_STARTED; then systemctl stop "$BUILD_UNIT" >/dev/null 2>&1 || true; fi
	if $BOOTSTRAP_STARTED; then systemctl stop "$BOOTSTRAP_UNIT" >/dev/null 2>&1 || true; fi
	# Only the throw-away build workspace is removed. Backups/releases are retained.
	if [[ -n ${STAGE:-} ]] && ! pgrep -u xflix-build >/dev/null; then rm -rf --one-file-system -- "$STAGE"; fi
	if ((status != 0)) && $STOPPED; then
		systemctl stop xflix.service >/dev/null 2>&1 || true
		printf 'Installation failed; stop requested, verify remaining processes. Backup: %s; migrations attempted: %s\n' "$BACKUP" "$MIGRATIONS" >&2
		printf 'No automatic schema rollback or restart. See scripts/INSTALLATION.md.\n' >&2
	fi
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

helper stage "$SOURCE" "$STAGE"
chown -R xflix-build:xflix-build "$STAGE"
# The transient cgroup kills leftover dependency children before privileged copying.
BUILD_STARTED=true
systemd-run --quiet --wait --collect --pipe --unit="$BUILD_UNIT" \
	--property=User=xflix-build --property=Group=xflix-build --property=KillMode=control-group \
	--property=NoNewPrivileges=yes --property=CapabilityBoundingSet= --property=ProtectSystem=strict \
	--property=ProtectControlGroups=yes --property=TimeoutStopSec=10 --property=RuntimeMaxSec=900 \
	--property=ProtectHome=yes --property=PrivateTmp=yes --property=PrivateDevices=yes --property="ReadWritePaths=$STAGE" \
	/usr/bin/env -i HOME="$STAGE" PATH="$PATH" /bin/bash "$STAGE/scripts/install-prepare.sh" "$STAGE"
if pgrep -u xflix-build >/dev/null; then die 'Build descendants remain; refusing privileged copy.'; fi
BUILD_STARTED=false
chown root:root "$STAGE"
chmod 0700 "$STAGE"
# Copy into a new root-owned tree, never execute dependencies as root.
helper seal "$SOURCE" "$STAGE" "$RELEASE"
install -o root -g xflix -m 0640 "$CONFIG/.env" "$RELEASE/.env"
install -d -m 0755 "$RELEASE/data"
helper unit "$RELEASE" "$RELEASE/.env" >"$RELEASE/xflix.service"
systemd-analyze verify "$RELEASE/xflix.service"

install -d -m 0700 "$BACKUP"
if [[ -n $OLD_RELEASE ]]; then
	install -m 0600 "$OLD_RELEASE/.env" "$BACKUP/.env"
else
	install -m 0600 "$CONFIG/.env" "$BACKUP/.env"
fi
if [[ -e $CONFIG/.admin-creds ]]; then install -m 0600 "$CONFIG/.admin-creds" "$BACKUP/.admin-creds"; fi
if [[ -e $UNIT ]]; then install -m 0600 "$UNIT" "$BACKUP/previous.service"; fi
printf '%s\n' "$OLD_RELEASE" >"$BACKUP/previous-release"
printf '%s\n' "$WAS_ACTIVE" >"$BACKUP/was-active"

# Maintenance is scoped to the identified unit. Never kill a port owner.
if [[ -n $OLD_RELEASE ]]; then
	# Apply a bounded graceful stop even to the legacy unit, whose kill policy is unknown.
	helper stop-policy
	systemctl daemon-reload
	STOPPED=true
	systemctl stop xflix.service
	[[ $(systemctl show -p MainPID --value xflix.service) == 0 ]] || die 'Service did not stop.'
	[[ $(systemctl show -p ControlGroup --value xflix.service) == '' ]] || die 'Service cgroup still exists; inspect remaining workers.'
fi
STOPPED=true
if pgrep -u xflix >/dev/null; then die 'Other runtime processes remain; stop CLI/maintenance writers first.'; fi
PORT=$(helper port "$CONFIG/.env")
"$NODE" "$SOURCE/scripts/install-port.cjs" "$PORT"
if [[ -e $SOURCE/data || -L $SOURCE/data ]]; then
	helper data "$SOURCE/data"
	tar --create --file "$BACKUP/data.tar" --directory "$SOURCE" data
fi
if [[ $DB_EXISTS == 1 ]]; then
	DB_NAME=$(helper db-name "$CONFIG/.env")
	# Local socket administration: no database password in argv, env or option files.
	mariadb-dump --no-defaults --user=root --protocol=socket --single-transaction --quick \
		--routines --events --triggers --hex-blob --databases "$DB_NAME" >"$BACKUP/database.sql.partial"
	[[ -s $BACKUP/database.sql.partial ]] || die 'Empty database backup.'
	mv "$BACKUP/database.sql.partial" "$BACKUP/database.sql"
else
	helper provision "$CONFIG/.env" | mariadb --no-defaults --binary-mode --user=root --protocol=socket >/dev/null 2>&1
	printf '%s\n' 'Fresh database, no prior schema to restore.' >"$BACKUP/fresh-database"
fi
printf '%s\n' 'Backup completed before application migrations; restore must be tested separately.' >"$BACKUP/complete"
if [[ ! -d $SOURCE/data ]]; then install -d -m 0750 "$SOURCE/data"; fi
helper own-data "$SOURCE/data"

MIGRATIONS=true
# Credentials travel only through stdin. This process has no root privileges.
BOOTSTRAP_STARTED=true
helper credentials "$CONFIG" | systemd-run --quiet --wait --collect --pipe --unit="$BOOTSTRAP_UNIT" \
	--property=User=xflix --property=Group=xflix --property=KillMode=control-group \
	--property=NoNewPrivileges=yes --property=CapabilityBoundingSet= --property=ProtectSystem=strict \
	--property=ProtectControlGroups=yes --property=TimeoutStopSec=10 --property=RuntimeMaxSec=600 \
	--property=ProtectHome=yes --property=PrivateTmp=yes --property=PrivateDevices=yes \
	/usr/bin/env -i HOME=/nonexistent PATH="$PATH" NODE_ENV=production "$NODE" "$RELEASE/scripts/install-db.cjs"
if pgrep -u xflix >/dev/null; then die 'Bootstrap descendants remain; refusing service startup.'; fi
BOOTSTRAP_STARTED=false
install -o root -g root -m 0644 "$RELEASE/xflix.service" "$UNIT"
helper clear-stop-policy
systemctl daemon-reload
systemctl enable xflix.service
systemctl start xflix.service
"$NODE" "$RELEASE/scripts/healthcheck.cjs" "$PORT"
systemctl is-active --quiet xflix.service
STOPPED=false
printf 'Installed %s. Backup: %s. Secrets remain in /etc/xflix, never printed.\n' "$RELEASE" "$BACKUP"
