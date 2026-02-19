#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════╗
# ║  XFlix — Script d'installation — pur bash                         ║
# ║  Node.js (nvm) · MariaDB · ffmpeg · npm · PM2 · secrets aléatoires║
# ╚═════════════════════════════════════════════════════════════════════╝
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Couleurs & helpers ────────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YEL='\033[1;33m'
BLU='\033[0;34m'; CYN='\033[0;36m'; BLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GRN}✓  $*${NC}"; }
info() { echo -e "${BLU}▶  $*${NC}"; }
warn() { echo -e "${YEL}⚠  $*${NC}"; }
err()  { echo -e "${RED}✗  $*${NC}" >&2; }
step() { echo -e "\n${BLD}${CYN}━━  $*${NC}"; }
die()  { err "$*"; exit 1; }

# ── Générateurs aléatoires (openssl uniquement) ──────────────────────
rand_hex()  { openssl rand -hex "${1:-32}"; }
rand_pass() {
  # Génère en mémoire (pas de pipe /dev/urandom|head qui provoque SIGPIPE)
  local len="${1:-20}"
  local raw
  raw="$(openssl rand -base64 $((len * 2)) | tr -dc 'A-Za-z0-9@#%+=')"
  printf '%s' "${raw:0:$len}"
}

echo ""
echo -e "${BLD}╔══════════════════════════════════════════════════════╗"
echo    "║         XFlix — Installation complète  🎬            ║"
echo -e "╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# ════════════════════════════════════════════════════════════════════
# 1. NODE.JS VIA NVM
# ════════════════════════════════════════════════════════════════════
step "1/7 · Node.js"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && source "$NVM_DIR/bash_completion"

NODE_OK=false
if command -v node &>/dev/null; then
  NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
  [[ "$NODE_MAJOR" -ge 18 ]] && NODE_OK=true
fi

if ! $NODE_OK; then
  info "Node.js >= 18 non trouvé — installation via nvm..."
  if [ ! -d "$NVM_DIR" ]; then
    info "Téléchargement de nvm v0.39.7..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    source "$NVM_DIR/nvm.sh"
  fi
  nvm install --lts --no-progress
  nvm use --lts
  nvm alias default 'lts/*'
  ok "Node.js $(node --version) installé."
else
  ok "Node.js $(node --version) — déjà disponible."
fi

command -v npm &>/dev/null || die "npm introuvable."

# ════════════════════════════════════════════════════════════════════
# 2. PAQUETS SYSTÈME (MariaDB, ffmpeg)
# ════════════════════════════════════════════════════════════════════
step "2/7 · Paquets système"

APT_NEEDED=()
{ command -v mariadb &>/dev/null || command -v mysql &>/dev/null; } || APT_NEEDED+=(mariadb-server)
command -v ffmpeg &>/dev/null || APT_NEEDED+=(ffmpeg)

if [ ${#APT_NEEDED[@]} -gt 0 ]; then
  command -v apt-get &>/dev/null || die "apt-get introuvable. Installez manuellement : ${APT_NEEDED[*]}"
  info "Installation via apt : ${APT_NEEDED[*]}"
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends "${APT_NEEDED[@]}" 2>&1 \
    | grep -E '^(Unpacking|Setting up|Processing)' || true
  ok "Paquets installés."
else
  ok "MariaDB et ffmpeg — déjà disponibles."
fi

# Choisit le client SQL disponible
MYSQL_BIN=""
for c in mariadb mysql; do command -v "$c" &>/dev/null && { MYSQL_BIN="$c"; break; }; done
[ -z "$MYSQL_BIN" ] && die "Aucun client MySQL/MariaDB trouvé."

# Choisit le daemon
MYSQLD_BIN=""
for b in /usr/sbin/mariadbd /usr/sbin/mysqld; do [ -x "$b" ] && { MYSQLD_BIN="$b"; break; }; done

# ── Démarrage de MariaDB ─────────────────────────────────────────────
if ! ss -tlnp 2>/dev/null | grep -q ':3306'; then
  info "Démarrage de MariaDB..."
  sudo mkdir -p /run/mysqld
  MYSQL_UID="$(id -u mysql 2>/dev/null || true)"
  MYSQL_GID="$(id -g mysql 2>/dev/null || true)"
  [ -n "$MYSQL_UID" ] && sudo chown "${MYSQL_UID}:${MYSQL_GID}" /run/mysqld 2>/dev/null || true

  sudo systemctl start mariadb 2>/dev/null \
    || sudo systemctl start mysql 2>/dev/null \
    || { [ -n "$MYSQLD_BIN" ] && sudo "$MYSQLD_BIN" --user=mysql &>/dev/null & } \
    || true

  # Attente jusqu'à 20s
  for i in $(seq 1 20); do
    ss -tlnp 2>/dev/null | grep -q ':3306' && break
    sleep 1
  done
  ss -tlnp 2>/dev/null | grep -q ':3306' \
    || die "Impossible de démarrer MariaDB. Logs : /var/log/mysql/error.log"
  ok "MariaDB démarré."
else
  ok "MariaDB — déjà en cours d'exécution."
fi

# ════════════════════════════════════════════════════════════════════
# 3. CONFIGURATION .env
# ════════════════════════════════════════════════════════════════════
step "3/7 · Configuration .env"

# Auto-détection du dossier médias
detect_media_dir() {
  local candidates=("/home/coder/OF" "/OF" "$HOME/OF" "/mnt/media" "/mnt/nas" "$HOME/Videos" "$HOME/Vidéos")
  for d in "${candidates[@]}"; do
    [ -d "$d" ] && { echo "$d"; return; }
  done
  echo ""
}

if [ ! -f .env ]; then
  info "Génération des secrets aléatoires et du fichier .env..."

  DB_PASS_GEN="$(rand_pass 22)"
  JWT_GEN="$(rand_hex 48)"
  MEDIA_DETECTED="$(detect_media_dir)"

  # Écriture du .env ligne par ligne (100% bash, pas de heredoc imbriqué)
  {
    echo "# XFlix — Configuration — généré le $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""
    echo "PORT=3000"
    echo ""
    echo "# Chemin absolu vers le dossier de médias"
    echo "MEDIA_DIR=${MEDIA_DETECTED:-/home/coder/OF}"
    echo ""
    echo "# Base de données"
    echo "DB_HOST=localhost"
    echo "DB_PORT=3306"
    echo "DB_USER=xflix"
    echo "DB_PASS=${DB_PASS_GEN}"
    echo "DB_NAME=xflix"
    echo ""
    echo "# JWT"
    echo "JWT_SECRET=${JWT_GEN}"
    echo "JWT_EXPIRES=7d"
  } > .env

  ok ".env créé avec secrets aléatoires."
  [ -n "$MEDIA_DETECTED" ] \
    && ok "MEDIA_DIR auto-détecté : $MEDIA_DETECTED" \
    || warn "MEDIA_DIR non trouvé — éditez .env avant le premier scan."
else
  ok ".env existant conservé."
  MEDIA_DETECTED="$(grep '^MEDIA_DIR=' .env | cut -d= -f2-)"
fi

# Charger les variables DB depuis .env
DB_USER="$(grep '^DB_USER=' .env | cut -d= -f2-)"
DB_PASS="$(grep '^DB_PASS=' .env | cut -d= -f2-)"
DB_NAME="$(grep '^DB_NAME=' .env | cut -d= -f2-)"
PORT_VAL="$(grep '^PORT=' .env | cut -d= -f2-)"
PORT_VAL="${PORT_VAL:-3000}"

# ── Création de la base de données ──────────────────────────────────
info "Configuration de la base de données '$DB_NAME'..."

SQL_SETUP="$(printf \
  "CREATE DATABASE IF NOT EXISTS \`%s\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '%s'@'localhost' IDENTIFIED BY '%s';
ALTER USER '%s'@'localhost' IDENTIFIED BY '%s';
GRANT ALL PRIVILEGES ON \`%s\`.* TO '%s'@'localhost';
FLUSH PRIVILEGES;" \
  "$DB_NAME" \
  "$DB_USER" "$DB_PASS" \
  "$DB_USER" "$DB_PASS" \
  "$DB_NAME" "$DB_USER")"

printf '%s\n' "$SQL_SETUP" | sudo "$MYSQL_BIN" -u root 2>/dev/null \
  || printf '%s\n' "$SQL_SETUP" | sudo mysql -u root 2>/dev/null \
  || die "Impossible de configurer la base de données."

ok "Base '$DB_NAME' prête (user: $DB_USER)."

# ════════════════════════════════════════════════════════════════════
# 4. DÉPENDANCES NPM
# ════════════════════════════════════════════════════════════════════
step "4/7 · Dépendances npm"

if npm ci --omit=dev --prefer-offline 2>&1 | tail -2; then
  ok "Dépendances installées (npm ci)."
elif npm install --omit=dev 2>&1 | tail -2; then
  ok "Dépendances installées (npm install)."
else
  npm install --ignore-scripts && ok "Dépendances installées (--ignore-scripts)."
fi

# ════════════════════════════════════════════════════════════════════
# 5. RÉPERTOIRES DE DONNÉES
# ════════════════════════════════════════════════════════════════════
step "5/7 · Répertoires"

mkdir -p data/thumbs data/encoded
ok "data/thumbs et data/encoded créés."

# ════════════════════════════════════════════════════════════════════
# 6. COMPTE ADMINISTRATEUR
# ════════════════════════════════════════════════════════════════════
step "6/7 · Compte administrateur"

ADMIN_CREDS_FILE="${SCRIPT_DIR}/.admin-creds"

if [ ! -f "$ADMIN_CREDS_FILE" ]; then
  ADMIN_EMAIL="admin@xflix.local"
  ADMIN_PASS="$(rand_pass 16)"
  printf 'ADMIN_EMAIL=%s\nADMIN_PASS=%s\n' "$ADMIN_EMAIL" "$ADMIN_PASS" > "$ADMIN_CREDS_FILE"
  chmod 600 "$ADMIN_CREDS_FILE"
else
  source "$ADMIN_CREDS_FILE"
  ADMIN_EMAIL="${ADMIN_EMAIL:-admin@xflix.local}"
  ADMIN_PASS="${ADMIN_PASS:-admin}"
fi

info "Création du compte admin (si absent)..."

# Génère un hash bcrypt et insère en base via node -e (Node.js = dépendance obligatoire)
ADMIN_CREATED="$(node -e "
const bcrypt = require('bcryptjs');
require('dotenv').config();
const { pool, initSchema } = require('./db');
(async () => {
  await initSchema();
  const [[ex]] = await pool.query('SELECT id FROM users WHERE email=?', ['${ADMIN_EMAIL}']);
  if (ex) { console.log('exists:' + ex.id); }
  else {
    const h = await bcrypt.hash('${ADMIN_PASS}', 12);
    const [r] = await pool.query(
      'INSERT INTO users (username,email,password_hash,role) VALUES (?,?,?,?)',
      ['admin','${ADMIN_EMAIL}',h,'admin']
    );
    console.log('created:' + r.insertId);
  }
  await pool.end();
})().catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });
" 2>&1)"

if [[ "$ADMIN_CREATED" == exists:* ]]; then
  ok "Compte admin déjà existant (id=${ADMIN_CREATED#exists:})."
elif [[ "$ADMIN_CREATED" == created:* ]]; then
  ok "Compte admin créé (id=${ADMIN_CREATED#created:})."
else
  warn "Résultat inattendu : $ADMIN_CREATED"
fi

# ════════════════════════════════════════════════════════════════════
# 7. PM2
# ════════════════════════════════════════════════════════════════════
step "7/7 · Gestionnaire de processus (PM2)"

if ! command -v pm2 &>/dev/null; then
  info "Installation de PM2 (global)..."
  npm install -g pm2 2>&1 | tail -2
  ok "PM2 installé."
else
  ok "PM2 $(pm2 --version 2>/dev/null | tail -1) — déjà disponible."
fi

# Libérer le port si nécessaire
fuser -k "${PORT_VAL}/tcp" 2>/dev/null || true
pm2 delete xflix 2>/dev/null || true
sleep 1

pm2 start server.js --name xflix 2>&1 | grep -E 'online|error' || true
pm2 save
ok "XFlix démarré via PM2."

PM2_STARTUP="$(pm2 startup 2>&1 | grep 'sudo env' || true)"
if [ -n "$PM2_STARTUP" ]; then
  eval "$PM2_STARTUP" 2>&1 | grep -E 'enabled|Command' || true
  ok "PM2 configuré pour démarrer au boot."
fi

# ════════════════════════════════════════════════════════════════════
# RÉSUMÉ
# ════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BLD}${GRN}╔══════════════════════════════════════════════════════╗"
echo    "║         Installation terminée avec succès !  🎉      ║"
echo -e "╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYN}${BLD}Accès${NC}"
echo -e "    URL             :  http://localhost:${PORT_VAL}"
echo -e "    Email admin     :  ${ADMIN_EMAIL}"
echo -e "    Mot de passe    :  ${ADMIN_PASS}  ${YEL}(sauvegardé dans .admin-creds)${NC}"
echo ""
echo -e "  ${CYN}${BLD}Base de données${NC}"
echo -e "    Base / User     :  ${DB_NAME} / ${DB_USER}"
echo -e "    Mot de passe DB :  ${DB_PASS}  ${YEL}(voir .env)${NC}"
echo ""
echo -e "  ${CYN}${BLD}Médias${NC}"
MDIR="${MEDIA_DETECTED:-}"
if [ -n "$MDIR" ] && [ -d "$MDIR" ]; then
  echo -e "    MEDIA_DIR       :  ${BLD}${MDIR}${NC}  ${GRN}✓ trouvé${NC}"
else
  echo -e "    MEDIA_DIR       :  ${YEL}Non configuré — éditez .env puis relancez${NC}"
fi
echo ""
echo -e "  ${CYN}${BLD}Commandes${NC}"
echo -e "    Logs            :  pm2 logs xflix"
echo -e "    Redémarrer      :  pm2 restart xflix"
echo -e "    Arrêter         :  pm2 stop xflix"
echo -e "    Scanner médias  :  node cli.js scan"
echo ""
