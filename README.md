# XFlix

Plateforme de streaming média locale avec interface Netflix-like.  
Backend **Node.js / Express**, base de données **MariaDB**, frontend **HTML/CSS/JS vanilla**.

---

## Fonctionnalités

- Parcourir des **performers** et leurs médias (vidéos + photos)
- **Streaming vidéo** natif avec range-request (seek, pause/reprise)
- **Galerie photos** avec visionneuse plein écran
- Génération automatique de **thumbnails** (Sharp pour photos, FFmpeg pour vidéos)
- **Recherche** globale et filtres avancés (taille, durée, type…)
- **Statistiques** (nombre de médias, taille totale, durée totale…)
- **Système de comptes** : inscription, connexion, JWT, réinitialisation de mot de passe par email
- **Rôles** : admin / member
- **Commentaires** et **réactions** (like/dislike) par média
- **Favoris** par utilisateur et globaux
- **Panneau admin** :
  - Gestion des utilisateurs
  - Scan des médias avec progression SSE en temps réel
  - Génération de thumbnails en batch
  - Détection de doublons
  - Paramètres SMTP et configuration
  - Nettoyage médias natif 3 phases (DB orphelins, fichiers non indexés, miniatures orphelines)

---

## Prérequis

| Composant | Version minimale | Notes |
|-----------|-----------------|-------|
| Linux | Ubuntu 20.04+ / Debian 11+ | |
| Node.js | 18.x | Installé automatiquement via nvm |
| MariaDB | 10.5+ | Ou MySQL 8.0+ |
| FFmpeg | toute version récente | Pour les thumbnails vidéo |

---

## Installation rapide (script automatique)

```bash
# Copier le dossier xflix sur votre serveur, puis :
cd xflix
bash install.sh
```

Le script `install.sh` :
1. Installe **nvm** + **Node.js** si absent
2. Lance `npm install`
3. Crée la base MariaDB et l'utilisateur si nécessaire
4. Démarre le serveur

---

## Installation manuelle

### 1. Dépendances système

```bash
sudo apt update
sudo apt install -y mariadb-server mariadb-client ffmpeg build-essential
sudo systemctl start mariadb
sudo systemctl enable mariadb
```

### 2. Base de données MariaDB

```bash
sudo mariadb -u root <<'SQL'
CREATE DATABASE IF NOT EXISTS xflix CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'xflix'@'localhost' IDENTIFIED BY 'xflix2026';
GRANT ALL PRIVILEGES ON xflix.* TO 'xflix'@'localhost';
FLUSH PRIVILEGES;
SQL
```

### 3. Node.js (via nvm)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
```

### 4. Dépendances npm

```bash
cd xflix
npm install
```

### 5. Configuration `.env`

Éditez le fichier `.env` à la racine de `xflix/` :

```env
# Serveur
PORT=3000

# Base de données
DB_HOST=localhost
DB_PORT=3306
DB_USER=xflix
DB_PASS=xflix2026
DB_NAME=xflix

# Auth JWT
JWT_SECRET=changez_moi_en_production
JWT_EXPIRES=7d

# Médias
MEDIA_DIR=/chemin/vers/votre/collection
THUMB_DIR=/chemin/vers/xflix/data/thumbs
```

### 6. Démarrage

```bash
node server.js
# ou en fond :
nohup node server.js > /tmp/xflix.log 2>&1 &
```

Puis ouvrez **http://localhost:3000** dans votre navigateur.

---

## Structure des médias

XFlix attend la structure suivante dans `MEDIA_DIR` :

```
MEDIA_DIR/           (ex: /home/coder/OF)
├── NomPerformer1/
│   └── ...          (sous-dossiers quelconques, récursif)
│       ├── video.mp4
│       └── photo.jpg
├── NomPerformer2/
│   └── ...
└── ...
```

Chaque **sous-dossier direct** de `MEDIA_DIR` devient un performer.  
Les fichiers sont indexés récursivement.

**Formats supportés :**

| Type | Extensions |
|------|-----------|
| Vidéo | `.mp4` `.mkv` `.avi` `.mov` `.webm` `.wmv` `.flv` `.m4v` `.ts` `.3gp` |
| Photo | `.jpg` `.jpeg` `.png` `.gif` `.webp` `.bmp` `.heic` `.heif` `.avif` |

---

## Premier lancement

1. Démarrer le serveur
2. Aller sur **http://localhost:3000**
3. **Créer un compte** — le premier compte peut être créé manuellement via le panel admin.
   L'utilisateur `admin@xflix.local` (mot de passe : `xflix2026`) est créé automatiquement par `install.sh`.
4. Cliquer sur ⚙️ pour accéder au **panneau admin**
5. Lancer un **Scan des médias** (mode : Tout / Photos / Vidéos)
6. (Optionnel) Lancer la **génération de thumbnails** en batch

---

## CLI

```bash
# Scanner les médias (sans serveur)
node cli.js scan

# Vider la base de données
node cli.js clear
```

---

## Structure du projet

```
xflix/
├── server.js              # Point d'entrée Express
├── db.js                  # Pool MariaDB + fonctions CRUD
├── scanner.js             # Scan async + génération de thumbs
├── cli.js                 # Interface ligne de commande
├── install.sh             # Script d'installation
├── .env                   # Configuration
├── package.json
│
├── middleware/
│   └── auth.js            # JWT (signToken, requireAuth, requireAdmin)
│
├── services/
│   └── mail.js            # Envoi d'emails (nodemailer)
│
├── routes/
│   ├── api.js             # /api : performers, media, stats, scan…
│   ├── auth.js            # /auth : register, login, profil…
│   ├── social.js          # /social : commentaires, réactions, favoris
│   ├── admin.js           # /admin : gestion users, settings, scan SSE…
│   └── stream.js          # Streaming vidéo / photos / thumbs
│
├── public/
│   ├── index.html
│   ├── admin.html
│   ├── css/style.css
│   ├── css/admin.css
│   ├── js/app.js
│   └── js/admin.js
│
└── data/
    └── thumbs/            # Thumbnails générés
```

---

## API — Routes principales

### Auth (`/auth`)

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/auth/register` | Inscription |
| POST | `/auth/login` | Connexion → JWT |
| GET | `/auth/me` | Profil (auth) |
| PUT | `/auth/profile` | Modifier profil (auth) |
| POST | `/auth/change-password` | Changer mot de passe (auth) |
| POST | `/auth/forgot-password` | Demande reset par email |
| POST | `/auth/reset-password` | Reset avec token |
| GET | `/auth/config` | Inscription ouverte ? |

### Médias (`/api`)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/performers` | Liste performers (filtre, tri, pagination) |
| GET | `/api/performers/:name` | Détail performer |
| POST | `/api/performers/:id/favorite` | Toggle favori |
| GET | `/api/performers/:name/videos` | Vidéos d'un performer |
| GET | `/api/performers/:name/photos` | Photos d'un performer |
| GET | `/api/media/:id` | Détail média |
| POST | `/api/media/:id/view` | Incrémenter le compteur de vues |
| POST | `/api/media/:id/favorite` | Toggle favori global |
| GET | `/api/search` | Recherche globale |
| GET | `/api/random/videos` | Vidéos aléatoires |
| GET | `/api/random/photos` | Photos aléatoires |
| GET | `/api/recent` | Derniers médias vus |
| GET | `/api/popular` | Médias les plus vus |
| GET | `/api/favorites` | Médias favoris globaux |
| GET | `/api/stats` | Statistiques globales |

### Social (`/social`)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET/POST | `/social/comments/:mediaId` | Voir / Poster un commentaire |
| PATCH/DELETE | `/social/comments/:id` | Modifier / Supprimer |
| GET/POST | `/social/reactions/:mediaId` | Voir / Ajouter like/dislike |
| GET | `/social/favorites` | Favoris de l'utilisateur |
| POST | `/social/favorites/:mediaId` | Toggle favori utilisateur |

### Admin (`/admin`) — auth admin requis

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/admin/stats` | Stats du dashboard |
| GET/PATCH/DELETE | `/admin/users` | Gestion utilisateurs |
| GET/PUT | `/admin/settings` | Paramètres SMTP/config |
| POST | `/admin/settings/test-smtp` | Tester SMTP |
| POST | `/admin/scan` | Scan SSE (progression temps réel) |
| POST | `/admin/scan/cancel` | Annuler scan |
| POST | `/admin/batch-thumbs` | Générer thumbs en batch (SSE) |
| POST | `/admin/duplicates/scan` | Détecter doublons (SSE) |
| POST | `/admin/duplicates/delete-bulk` | Supprimer doublons en masse (SSE) |
| DELETE | `/admin/duplicates/:id` | Supprimer un doublon |
| DELETE | `/admin/media/:id` | Supprimer media |
| POST | `/admin/clean-media` | Nettoyage natif 3 phases (SSE) |

### Streaming (`/`)

| Route | Description |
|-------|-------------|
| `/stream/:id` | Streaming vidéo (range requests) |
| `/photo/:id` | Servir une photo |
| `/thumb/:id` | Servir un thumbnail |

---

## Performances

- **Scan async** : walker de fichiers en générateur async — pas de blocage de l'event loop même sur 60 000+ fichiers
- **Bulk pre-load** : au démarrage du scan, tous les chemins existants sont chargés en **une seule requête** (au lieu de N requêtes par performer)
- **Batch insert** : nouveaux fichiers insérés par lots de 500 avec `INSERT IGNORE … VALUES (…),(…)…`
- **SSE** : progression du scan envoyée en temps réel via Server-Sent Events
- **Compression gzip** : HTML/CSS/JS/JSON compressés, vidéo/image/SSE exclus
- **Random efficace** : `ORDER BY RAND()` sur sous-requête d'IDs (index uniquement)
- **Réactions** : comptage like/dislike en une requête `SUM(type='like')`

---

## Dépannage

### Le serveur ne démarre pas
```bash
cat /tmp/xflix.log
sudo systemctl status mariadb
mysql -u xflix -pxflix2026 xflix -e "SHOW TABLES;"
```

### Le scan ne trouve aucun fichier
- Vérifier `MEDIA_DIR` dans `.env`
- Les sous-dossiers directs de `MEDIA_DIR` doivent contenir des fichiers médias
- Les extensions non reconnues sont ignorées silencieusement

### Les thumbnails ne se génèrent pas
- Vérifier FFmpeg : `ffmpeg -version`
- Vérifier que `data/thumbs/` est accessible en écriture
- Sharp nécessite `build-essential` (`sudo apt install build-essential`)

### Réinitialisation sans SMTP configuré
Le lien de reset est renvoyé directement dans la réponse JSON de `/auth/forgot-password` (mode dev).

---

## Sécurité (recommandations production)

1. Changer `JWT_SECRET` dans `.env`
2. Changer le mot de passe MariaDB
3. Placer XFlix derrière un reverse proxy (nginx/Caddy) avec HTTPS
4. Désactiver l'inscription depuis le panneau admin une fois les comptes créés
5. Restreindre l'accès réseau au port 3000

---

## Licence

Usage privé / personnel.
