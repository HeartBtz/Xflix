# XFlix

Plateforme de **streaming média locale** avec interface Netflix-like.  
Backend **Node.js / Express**, base de données **MariaDB**, frontend **HTML/CSS/JS vanilla** — 0 dépendance frontend.

---

## Fonctionnalités

### Lecture & navigation
- Parcourir les **performers** et leurs médias (vidéos + photos)
- **Streaming vidéo** avec range-request (seek instantané, pause/reprise)
- **Galerie photos** avec visionneuse plein écran et navigation clavier
- Page **Découverte** (vidéos/photos aléatoires)
- **Recherche** globale + filtres avancés (taille, durée, type, favori…)

### Comptes & social
- **Inscription / Connexion** avec JWT (expiration configurable)
- **Rôles** : `admin` / `member`
- **Commentaires** et **réactions** (like / dislike) par média
- **Favoris** personnels et globaux
- Réinitialisation de mot de passe par email (SMTP ou lien direct en dev)

### Panneau Admin
- Gestion des **utilisateurs** (rôle, suppression)
- **Scan des médias** avec progression SSE en temps réel
- Enrichissement automatique des **durées vidéo** (ffprobe) post-scan  
- Génération automatique des **thumbnails** manquants post-scan
- **Navigateur de médias** : filtrer / supprimer par performer, type, nom
- **Détection de doublons** (hash partiel 64 KB) avec suppression en masse
- **Nettoyage médias** : entrées DB orphelines · fichiers non indexés · miniatures orphelines
- **Purge des courtes vidéos** : supprimer toutes les vidéos sous un seuil en minutes
- **Paramètres SMTP** et ouverture/fermeture des inscriptions

### Performances
- DB indexée : `last_viewed`, `(performer_id, type)`, `(type, favorite)`, `(type, view_count)`
- `random_cover_id` stocké par performer — élimine les `ORDER BY RAND()` par ligne à l'affichage
- Walker de fichiers async (générateur) — pas de blocage même sur 60 000+ fichiers
- Insertions en **batch de 500** (`INSERT IGNORE … VALUES …`)
- Compression gzip sélective (JSON/HTML/CSS/JS — exclut vidéo/image/SSE)
- Retry automatique des requêtes API côté client (réseau instable)
- Handlers globaux `uncaughtException` / `unhandledRejection` — process jamais crashé

---

## Prérequis

| Composant | Version min. | Notes |
|---|---|---|
| Linux | Ubuntu 20.04+ / Debian 11+ | |
| Node.js | 18.x | Installé automatiquement via nvm |
| MariaDB | 10.5+ | Ou MySQL 8.0+ |
| FFmpeg | toute version récente | Thumbnails vidéo + durées |

---

## Installation rapide

```bash
git clone https://github.com/HeartBtz/Xflix.git
cd Xflix
bash install.sh
```

Le script `install.sh` :
1. Installe **nvm** + **Node.js 20** si absent
2. Installe et démarre **MariaDB** si absent
3. Crée la base `xflix` et l'utilisateur MariaDB
4. Installe les **dépendances npm**
5. Génère un fichier `.env` par défaut si inexistant
6. Crée le compte `admin@xflix.local` / `xflix2026`
7. Démarre le serveur via **PM2** et configure le démarrage au boot

Puis ouvrez **http://localhost:3000** et lancez un scan depuis ⚙️ Admin.

---

## Installation manuelle

### 1. Dépendances système

```bash
sudo apt update
sudo apt install -y mariadb-server ffmpeg build-essential
sudo systemctl enable --now mariadb
```

### 2. Base de données MariaDB

```bash
sudo mariadb -u root << 'SQL'
CREATE DATABASE IF NOT EXISTS xflix CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'xflix'@'localhost' IDENTIFIED BY 'xflix2026';
GRANT ALL PRIVILEGES ON xflix.* TO 'xflix'@'localhost';
FLUSH PRIVILEGES;
SQL
```

### 3. Node.js via nvm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20 && nvm use 20 && nvm alias default 20
```

### 4. Dépendances npm

```bash
npm install
```

### 5. Configuration `.env`

```bash
cp .env.example .env
nano .env          # Renseigner au minimum MEDIA_DIR et JWT_SECRET
```

### 6. Démarrage

```bash
# Développement
node server.js

# Production (PM2)
npm install -g pm2
pm2 start server.js --name xflix
pm2 save && pm2 startup
```

---

## Structure des médias

XFlix attend la structure suivante dans `MEDIA_DIR` :

```
MEDIA_DIR/
├── NomPerformer1/
│   ├── dossier-quelconque/
│   │   ├── video.mp4
│   │   └── photo.jpg
│   └── autre-sous-dossier/
│       └── ...
├── NomPerformer2/
│   └── ...
└── ...
```

Chaque **sous-dossier direct** de `MEDIA_DIR` devient un performer.  
Les fichiers sont indexés **récursivement**.

**Formats supportés :**

| Type | Extensions |
|---|---|
| Vidéo | `.mp4` `.mkv` `.avi` `.mov` `.webm` `.wmv` `.flv` `.m4v` `.ts` `.3gp` |
| Photo | `.jpg` `.jpeg` `.png` `.gif` `.webp` `.bmp` `.heic` `.heif` `.avif` |

---

## Premier lancement

1. Ouvrir **http://localhost:3000**
2. Se connecter avec `admin@xflix.local` / `xflix2026` (créé par `install.sh`)
3. Cliquer sur ⚙️ → **Admin**
4. Lancer un **Scan des médias** (Tout / Photos / Vidéos)
5. Les thumbnails et durées vidéo se génèrent automatiquement en arrière-plan

> **Première utilisation sans `install.sh`** : créez un compte, puis passez-le admin en DB :  
> `UPDATE users SET role='admin' WHERE email='votre@email.com';`

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
├── db.js                  # Pool MariaDB + schéma + fonctions CRUD
├── scanner.js             # Scan async, thumbs, durées, auto-thumbs post-scan
├── cli.js                 # Interface ligne de commande
├── install.sh             # Script d'installation tout-en-un
├── .env                   # Configuration locale (ignoré par git)
├── .env.example           # Modèle de configuration
├── package.json
│
├── middleware/
│   └── auth.js            # JWT (signToken, verifyToken, requireAuth, requireAdmin)
│
├── services/
│   └── mail.js            # Envoi d'emails (nodemailer, SMTP)
│
├── routes/
│   ├── api.js             # /api — performers, médias, stats, search, favoris…
│   ├── auth.js            # /auth — register, login, profil, reset password
│   ├── social.js          # /social — commentaires, réactions, favoris user
│   ├── admin.js           # /admin — users, settings, scan SSE, outils…
│   └── stream.js          # Streaming vidéo / photos / thumbnails
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
    └── thumbs/            # Thumbnails générés (ignoré par git)
```

---

## API — Routes principales

### Auth `/auth`

| Méthode | Route | Description |
|---|---|---|
| POST | `/auth/register` | Inscription |
| POST | `/auth/login` | Connexion → JWT |
| GET | `/auth/me` | Profil (auth) |
| PUT | `/auth/profile` | Modifier profil |
| POST | `/auth/change-password` | Changer mot de passe |
| POST | `/auth/forgot-password` | Demande reset par email |
| POST | `/auth/reset-password` | Reset avec token |
| GET | `/auth/config` | Inscription ouverte ? |

### Médias `/api`

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/performers` | Liste performers (filtre, tri, pagination) |
| GET | `/api/performers/:name` | Détail performer |
| POST | `/api/performers/:id/favorite` | Toggle favori global |
| GET | `/api/performers/:name/videos` | Vidéos avec filtres + pagination |
| GET | `/api/performers/:name/photos` | Photos avec filtres + pagination |
| GET | `/api/media/:id` | Détail média |
| POST | `/api/media/:id/view` | Incrémenter vues |
| POST | `/api/media/:id/favorite` | Toggle favori global |
| GET | `/api/search` | Recherche globale |
| GET | `/api/random/videos` | Vidéos aléatoires |
| GET | `/api/random/photos` | Photos aléatoires |
| GET | `/api/recent` | Derniers médias consultés |
| GET | `/api/popular` | Médias les plus vus |
| GET | `/api/favorites` | Médias favoris globaux |
| GET | `/api/stats` | Statistiques globales |

### Social `/social`

| Méthode | Route | Description |
|---|---|---|
| GET | `/social/comments/:mediaId` | Liste des commentaires |
| POST | `/social/comments/:mediaId` | Poster un commentaire |
| PATCH | `/social/comments/:id` | Modifier un commentaire |
| DELETE | `/social/comments/:id` | Supprimer un commentaire |
| GET | `/social/reactions/:mediaId` | Voir réactions |
| POST | `/social/reactions/:mediaId` | Ajouter like/dislike |
| GET | `/social/favorites` | Favoris de l'utilisateur |
| POST | `/social/favorites/:mediaId` | Toggle favori utilisateur |

### Admin `/admin` — rôle admin requis

| Méthode | Route | Description |
|---|---|---|
| GET | `/admin/stats` | Stats dashboard |
| GET | `/admin/users` | Liste utilisateurs |
| PATCH | `/admin/users/:id/role` | Changer rôle |
| DELETE | `/admin/users/:id` | Supprimer utilisateur |
| GET/PUT | `/admin/settings` | Paramètres SMTP / config |
| POST | `/admin/settings/test-smtp` | Test connexion SMTP |
| POST | `/admin/scan` | Scan SSE (progression temps réel) |
| POST | `/admin/scan/cancel` | Annuler scan |
| POST | `/admin/batch-thumbs` | Générer thumbnails en batch (SSE) |
| GET | `/admin/media` | Navigateur de médias |
| DELETE | `/admin/media/:id` | Supprimer un média |
| POST | `/admin/duplicates/scan` | Détecter doublons (SSE) |
| POST | `/admin/duplicates/delete-bulk` | Supprimer doublons en masse (SSE) |
| DELETE | `/admin/duplicates/:id` | Supprimer un doublon |
| POST | `/admin/clean-media` | Nettoyage 3 phases (SSE) |
| POST | `/admin/purge-short-videos` | Supprimer vidéos < seuil en minutes (SSE) |

### Streaming `/`

| Route | Description |
|---|---|
| `/stream/:id` | Streaming vidéo (range requests, ETag, cache 1h) |
| `/photo/:id` | Servir une photo (cache 24h, ETag) |
| `/thumb/:id` | Servir un thumbnail |

---

## Dépannage

### Le serveur ne démarre pas
```bash
pm2 logs xflix --err --lines 50
sudo systemctl status mariadb
mariadb -u xflix -pxflix2026 xflix -e "SHOW TABLES;"
```

### Le scan ne trouve aucun fichier
- Vérifier `MEDIA_DIR` dans `.env` — doit être un chemin absolu
- Les **sous-dossiers directs** de `MEDIA_DIR` deviennent des performers
- Vérifier les droits de lecture : `ls -la "$MEDIA_DIR"`

### Les thumbnails ne se génèrent pas
```bash
ffmpeg -version           # FFmpeg doit être installé
ls -la data/thumbs/       # Vérifier accès en écriture
sudo apt install build-essential   # Requis pour Sharp (compilation native)
```

### Reset mot de passe sans SMTP
En mode développement, le lien de reset est retourné **directement dans la réponse JSON** de `POST /auth/forgot-password`.

### Mettre à jour les compteurs après suppression en DB
```bash
node -e "const {pool,updatePerformerCounts}=require('./db'); updatePerformerCounts().then(()=>pool.end())"
```

---

## Sécurité (recommandations production)

1. **Changer `JWT_SECRET`** :
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. **Changer le mot de passe MariaDB** — `xflix2026` est public
3. Placer XFlix derrière un **reverse proxy** (nginx / Caddy) avec HTTPS
4. **Fermer les inscriptions** depuis Admin → Paramètres une fois les comptes créés
5. Port 3000 ne doit pas être exposé directement sur Internet

---

## Licence

Usage privé / personnel.
