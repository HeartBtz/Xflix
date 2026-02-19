#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  XFlix — Script d’installation                              ║
# ║  Node.js (nvm) • MariaDB • npm • PM2 • compte admin         ║
# ╚══════════════════════════════════════════════════════════════════╝

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Couleurs ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $*${NC}"; }
info() { echo -e "${BLUE}▶  $*${NC}"; }
warn() { echo -e "${YELLOW}⚠  $*${NC}"; }
err()  { echo -e "${RED}❌ $*${NC}" >&2; }
step() { echo -e "\n${BOLD}${CYAN}━━ $* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║              XFlix — Installation complète           ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ════════════════════════════════════════════════════════════════════
# 1. NODE.JS VIA NVM
# ════════════════════════════════════════════════════════════════════
step "Node.js"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')" -lt 18 ]]; then
  info "Node.js >= 18 non trouvé — installation via nvm..."
  if [ ! -d "$NVM_DIR" ]; then
    info "Téléchargement de nvm..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    source "$NVM_DIR/nvm.sh"
  fi
  nvm install 20 --no-progress
  nvm use 20
  nvm alias default 20
  ok "Node.js $(node --version) installé via nvm."
else
  ok "Node.js $(node --version) — OK"
fi

if ! command -v npm &>/dev/null; then
  err "npm introuvable même après installation de Node. Abandon."
  exit 1
fi

# ════════════════════════════════════════════════════════════════════
# 2. MARIADB
# ════════════════════════════════════════════════════════════════════
step "MariaDB"

MYSQLD_BIN=""
for b in /usr/sbin/mariadbd /usr/sbin/mysqld; do
  [ -x "$b" ] && { MYSQLD_BIN="$b"; break; }
done

MYSQL_CLIENT=""
for c in mariadb mysql; do
  command -v "$c" &>/dev/null && { MYSQL_CLIENT="$c"; break; }
done

if [ -z "$MYSQLD_BIN" ]; then
  info "MariaDB non installé — installation via apt..."
  if ! command -v apt-get &>/dev/null; then
    err "apt-get introuvable. Installez MariaDB manuellement puis relancez."
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends mariadb-server 2>&1 | grep -v "^debconf"
  MYSQLD_BIN="/usr/sbin/mariadbd"
  MYSQL_CLIENT="mariadb"
  ok "MariaDB installé."
else
  ok "MariaDB binaire trouvé : $MYSQLD_BIN"
fi

# ── Installer ffmpeg si absent (nécessaire pour les miniatures vidéo) ──
if ! command -v ffmpeg &>/dev/null; then
  info "ffmpeg non trouvé — installation via apt..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get install -y --no-install-recommends ffmpeg 2>&1 | grep -v "^debconf"
    ok "ffmpeg installé."
  else
    warn "apt-get introuvable. Installez ffmpeg manuellement pour activer les miniatures vidéo."
  fi
else
  ok "ffmpeg trouvé : $(ffmpeg -version 2>&1 | head -1 | cut -d' ' -f3)"
fi

# ── Démarrer MariaDB si pas actif ───────────────────────────────────
if ! ss -tlnp 2>/dev/null | grep -q ':3306'; then
  info "Démarrage de MariaDB..."

  # Créer /run/mysqld si nécessaire
  if [ ! -d /run/mysqld ]; then
    sudo mkdir -p /run/mysqld
  fi
  MYSQL_UID=$(id -u mysql 2>/dev/null || echo "")
  MYSQL_GID=$(id -g mysql 2>/dev/null || echo "")
  if [ -n "$MYSQL_UID" ]; then
    sudo chown "${MYSQL_UID}:${MYSQL_GID}" /run/mysqld 2>/dev/null || true
  fi

  # Essayer systemctl d'abord
  if sudo systemctl start mariadb 2>/dev/null || sudo systemctl start mysql 2>/dev/null; then
    sleep 3
  else
    # Démarrage manuel
    sudo "$MYSQLD_BIN" --user=mysql --daemonize 2>/dev/null || \
    sudo "$MYSQLD_BIN" --user=mysql &>/dev/null &
    sleep 6
  fi

  if ss -tlnp 2>/dev/null | grep -q ':3306'; then
    ok "MariaDB démarré."
  else
    err "Impossible de démarrer MariaDB. Vérifiez les logs : /var/log/mysql/error.log"
    exit 1
  fi
else
  ok "MariaDB déjà en cours d'exécution."
fi

# ── Configurer la base de données ───────────────────────────────────
info "Configuration de la base de données xflix..."
_SQL="CREATE DATABASE IF NOT EXISTS xflix CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'xflix'@'localhost' IDENTIFIED BY 'xflix2026';
GRANT ALL PRIVILEGES ON xflix.* TO 'xflix'@'localhost';
FLUSH PRIVILEGES;"

printf '%s\n' "$_SQL" | sudo "$MYSQL_CLIENT" -u root 2>/dev/null || \
printf '%s\n' "$_SQL" | sudo mariadb          -u root 2>/dev/null || \
printf '%s\n' "$_SQL" | sudo mysql            -u root 2>/dev/null || true
ok "Base de données prête (xflix / xflix2026)."

# ════════════════════════════════════════════════════════════════════
# 3. DÉPENDANCES NPM
# ════════════════════════════════════════════════════════════════════
step "Dépendances npm"

info "Installation des paquets..."
if npm ci --omit=dev 2>&1 | tail -3; then
  ok "Dépendances installées (npm ci)."
elif npm install 2>&1 | tail -3; then
  ok "Dépendances installées (npm install)."
else
  warn "Retry sans scripts natifs..."
  npm install --ignore-scripts
  ok "Dépendances installées (--ignore-scripts)."
fi

# ════════════════════════════════════════════════════════════════════
# 4. RÉPERTOIRES DE DONNÉES
# ════════════════════════════════════════════════════════════════════
step "Répertoires"

mkdir -p data/thumbs
ok "data/thumbs créé."

# Créer .env si absent
if [ ! -f .env ]; then
  info "Création du fichier .env par défaut..."
  cat > .env <<'ENV'
DB_HOST=localhost
DB_PORT=3306
DB_USER=xflix
DB_PASS=xflix2026
DB_NAME=xflix
JWT_SECRET=changeme_random_secret_here
PORT=3000
MEDIA_DIR=/home/coder/OF
ENV
  warn ".env créé — pensez à modifier JWT_SECRET et MEDIA_DIR !"
else
  ok ".env existant conservé."
fi

# Vérifier si MEDIA_DIR est encore la valeur par défaut
MEDIA_DIR_VAL="$(grep '^MEDIA_DIR=' .env 2>/dev/null | cut -d= -f2-)"
if [[ "$MEDIA_DIR_VAL" == "/home/coder/OF" ]] || [[ -z "$MEDIA_DIR_VAL" ]]; then
  warn "MEDIA_DIR n’est pas configuré dans .env — modifiez-le avant de lancer un scan."
elif [ ! -d "$MEDIA_DIR_VAL" ]; then
  warn "MEDIA_DIR=$MEDIA_DIR_VAL n’existe pas encore sur le disque."
fi

# ════════════════════════════════════════════════════════════════════
# 5. COMPTE ADMIN PAR DÉFAUT
# ════════════════════════════════════════════════════════════════════
step "Compte administrateur"

info "Création du compte admin si absent..."
node - <<'NODEJS'
const bcrypt = require('bcryptjs');
require('dotenv').config();
const { pool, initSchema } = require('./db');

(async () => {
  await initSchema();

  const email    = 'admin@xflix.local';
  const username = 'admin';
  const password = 'xflix2026';

  const [[existing]] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    console.log(`✅ Compte admin déjà existant (id=${existing.id})`);
  } else {
    const hash = await bcrypt.hash(password, 12);
    const [r]  = await pool.query(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [username, email, hash, 'admin']
    );
    console.log(`✅ Compte admin créé (id=${r.insertId}) — ${email} / ${password}`);
  }

  await pool.end();
})().catch(e => { console.error('❌ Erreur création admin :', e.message); process.exit(1); });
NODEJS

# ════════════════════════════════════════════════════════════════════
# 6. PERSISTANCE DU PROCESS (PM2)
# ════════════════════════════════════════════════════════════════════
step "Gestionnaire de process (PM2)"

if ! command -v pm2 &>/dev/null; then
  info "Installation de PM2..."
  npm install -g pm2 2>&1 | tail -2
  ok "PM2 installé."
else
  ok "PM2 déjà disponible ($(pm2 --version 2>/dev/null | tail -1))."
fi

# Écrire le fichier service systemd au cas où (utile sur vrais serveurs Linux)
NODE_BIN="$(which node)"
XFLIX_DIR="$(pwd)"
sudo tee /etc/systemd/system/xflix.service > /dev/null 2>&1 <<SYSTEMD
[Unit]
Description=XFlix Media Server
After=network.target mariadb.service
Wants=mariadb.service

[Service]
Type=simple
User=${USER:-coder}
WorkingDirectory=${XFLIX_DIR}
ExecStart=${NODE_BIN} server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
EnvironmentFile=${XFLIX_DIR}/.env

[Install]
WantedBy=multi-user.target
SYSTEMD

# Arrêter toute instance existante sur le port 3000
fuser -k 3000/tcp 2>/dev/null || true
pm2 delete xflix 2>/dev/null || true
sleep 1

# Démarrer via PM2
pm2 start server.js --name xflix 2>&1 | grep -E 'online|error|Done'
pm2 save
ok "XFlix démarré via PM2."

# Configurer PM2 pour démarrer au boot
PM2_STARTUP=$(pm2 startup 2>&1 | grep 'sudo env')
if [ -n "$PM2_STARTUP" ]; then
  eval "$PM2_STARTUP" 2>&1 | grep -E 'Command|error|enabled' || true
  ok "PM2 configuré pour démarrer au boot."
fi

# ════════════════════════════════════════════════════════════════════
# 7. RÉSUMÉ
# ════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════╗"
echo "║           Installation terminée avec succès ! 🎉     ║"
echo "╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}URL            :${NC} http://localhost:3000"
echo -e "  ${CYAN}Admin email    :${NC} admin@xflix.local"
echo -e "  ${CYAN}Admin password :${NC} xflix2026"
echo -e "  ${CYAN}Logs           :${NC} pm2 logs xflix"
echo -e "  ${CYAN}Contrôle PM2   :${NC} pm2 [start|stop|restart|status] xflix"
echo ""
echo -e "  ${YELLOW}⚠  Avant le premier scan, vérifiez MEDIA_DIR dans .env${NC}"
echo -e "     Chemin actuel : ${MEDIA_DIR_VAL:-non défini}"
echo -e "     Pour modifier : ${BOLD}nano .env${NC}"
echo ""
