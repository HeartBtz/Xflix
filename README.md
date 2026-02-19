# XFlix

**Self-hosted Netflix-like media browser** for local video and photo collections.

Node.js · Express · MariaDB · Vanilla JS frontend (zero build step)

---

## Table of contents

1. [Features](#features)
2. [Architecture overview](#architecture-overview)
3. [Requirements](#requirements)
4. [Quick install](#quick-install)
5. [Manual install](#manual-install)
6. [Configuration reference](#configuration-reference)
7. [Directory layout](#directory-layout)
8. [How the scanner works](#how-the-scanner-works)
9. [Thumbnail system](#thumbnail-system)
10. [API reference](#api-reference)
11. [Admin panel](#admin-panel)
12. [Keyboard shortcuts](#keyboard-shortcuts)
13. [Troubleshooting](#troubleshooting)
14. [Contributing](#contributing)
15. [License](#license)

---

## Features

### Browsing & playback
- Browse **performers** (one subdirectory = one performer) and their media
- **Video streaming** with HTTP Range requests — instant seek, pause/resume
- **Photo lightbox** with full-screen view and keyboard navigation
- **Discover** page with random videos + photos
- Global **search** with advanced filters (size, duration, type, favourite…)

---

## Recent changes (v1.2+)

- Auto-tagging of media on scan: resolution (4K/1080p/720p/SD), codec (H.265/VP9/AV1), and duration buckets (Court/Moyen/Long).
- Dark / light theme toggle persisted in `localStorage`.
- Tag-based filtering on performer pages with per-performer tag counts.
- "Nouveautés" (Recently added) page and Discover section.
- Related videos shown inside the player (same performer random sample).
- Custom thumbnail upload endpoint: `POST /api/thumb/:id/upload` (accepts base64 image).
- Infinite scroll on performer video lists (replaces pagination when enabled).
- Video technical info (codec, fps, bitrate, audio sample rate) extracted via `ffprobe` and shown in the player.

### v2.0 — Encoding system & Admin redesign

- New video re-encoding subsystem: encode to H.265 (HEVC) or AV1 with CPU or hardware backends.
- Automatic hardware detection (NVIDIA NVENC, Intel QSV, VA-API) with CPU fallback (libx265, SVT-AV1, libaom-av1).
- Worker pool and queue management for multi-GPU / concurrent encodes; enqueue from Admin UI.
- Real-time progress (SSE) and job history with cancel/retry/delete actions.
- Admin UI completely redesigned (modern dark theme, frosted navbar, Encodage tab).


### Accounts & social
- **Register / Login** via JWT (7-day expiry by default, configurable)
- Roles: `admin` / `member` — first registered user is automatically admin
- Per-media **comments** and **reactions** (like / dislike)
- **Personal favourites** (per-user) and **global favourites** (admin-set)
- Password reset by email (SMTP) or direct reset link returned in dev mode

### Admin panel
- **Scan** with live SSE progress stream
- Auto-enrich **video durations** (ffprobe) + auto-generate **thumbnails** post-scan
- **Duplicate detection** using partial MD5 hash (first 64 KB) + bulk delete
- **Clean media**: find orphaned DB rows, unindexed files, orphaned thumbnails
- **Purge short videos**: delete all videos under a configurable duration threshold
- **Media browser**: filter and delete by performer / type / filename
- **Batch thumbnail** generation with live progress
- **User management**: change role, delete account
- **SMTP settings** editable at runtime (no restart needed)

## Encoding

XFlix now includes an integrated video re-encoding subsystem accessible from the Admin UI (Encodage).

- Supported target codecs: **H.265 (hevc)** and **AV1**.
- Backends: NVIDIA NVENC, Intel QSV, VA-API (AMD/Intel), and CPU encoders (`libx265`, `libsvtav1`, `libaom-av1`).
- Detects available hardware and exposes presets in the Admin → Encodage tab.
- Features: job queue, multi-worker encoding, per-job progress (SSE), job history, cancel/retry/delete, and optional replacement of originals with rollback safety.

API endpoints (Admin-only):

- `GET /admin/encode/capabilities` — hardware + presets
- `GET /admin/encode/status` — current queue status
- `GET /admin/encode/history` — paginated job history
- `POST /admin/encode/enqueue` — enqueue media IDs for encoding
- `POST /admin/encode/cancel/:id` — cancel single job
- `POST /admin/encode/cancel-all` — cancel all jobs
- `POST /admin/encode/retry/:id` — retry a failed job
- `DELETE /admin/encode/job/:id` — delete job record
- `POST /admin/encode/workers` — set max worker count
- `GET /admin/encode/videos` — searchable/filterable video list
- `GET /admin/encode/codec-stats` — counts/sizes by codec
- `GET /admin/encode/events` — SSE event stream for job progress

Database: migration adds the `encode_jobs` table (job metadata, progress, paths, timestamps).

Requirements & notes:

- FFmpeg 6+ recommended; encoders should be compiled in (NVENC/VAAPI/QSV where applicable).
- If using NVENC, install NVIDIA drivers and `nvidia-smi` should be available; VA-API requires `/dev/dri` access.
- On systems without GPU support, CPU encoders are used (slower, but reliable).
- Large-scale encoding is disk/CPU/GPU intensive — tune `encMaxWorkers` in the Admin panel.

### Examples

Here are quick `curl` examples showing common admin operations for the encoding subsystem. All endpoints require an admin JWT token in the `Authorization: Bearer <token>` header.

- Authenticate (obtain token):

```bash
curl -X POST https://your-host:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@xflix.local","password":"xflix2026"}'

# response: { "token": "ey..." }
```

- Get hardware capabilities and available presets:

```bash
curl -H "Authorization: Bearer $TOKEN" https://your-host:3000/admin/encode/capabilities
```

- List videos (filterable) to select media IDs to enqueue:

```bash
curl -H "Authorization: Bearer $TOKEN" "https://your-host:3000/admin/encode/videos?limit=50&performer_id=3&codec=h264"
```

- Enqueue media IDs for encoding (example: encode to preset `cpu_h265`):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  https://your-host:3000/admin/encode/enqueue \
  -d '{"mediaIds":[12,45,67],"presetId":"cpu_h265","quality":"balanced","replaceOriginal":false}'
```

- Poll queue status:

```bash
curl -H "Authorization: Bearer $TOKEN" https://your-host:3000/admin/encode/status
```

- Streams (SSE) for real-time progress (example client using `curl`):

```bash
curl -N -H "Authorization: Bearer $TOKEN" https://your-host:3000/admin/encode/events
```

### Screenshots


![Admin Encodage tab](docs/screenshots/encodage.png)
![Admin Dashboard](docs/screenshots/dashboard.png)


### Performance
| Technique | Effect |
|---|---|
| DB indexes on `last_viewed`, `(performer_id, type)`, `(type, favorite)`, `(type, view_count)` | Fast sort / filter queries |
| `random_cover_id` stored per performer | No `ORDER BY RAND()` on every page load |
| Async walker (async generator) | 60 000+ files scanned without blocking the event loop |
| Batch insert (500 rows / query) | 10× faster than individual INSERTs |
| Selective gzip (JSON/HTML/CSS/JS only) | No double-compressing video or images |
| Thumb semaphore (max 3 concurrent) | Prevents ffmpeg flood when a performer loads |
| API retry with backoff on the client | Transparent recovery from brief server hiccups |

---

## Architecture overview

```
Browser (Vanilla JS SPA)
    │  REST + SSE  │  Range streaming
    ▼              ▼
┌────────────────────────────────────────────┐
│              Express (server.js)           │
│  /auth   /social   /admin   /api           │
│  /stream   /photo   /thumb   /download     │
└──────────┬─────────────────────────────────┘
           │ mysql2/promise pool (20 connections)
           ▼
      MariaDB (xflix DB)
      ┌──────────────┐
      │ performers   │ ◄── one row per MEDIA_DIR subdirectory
      │ media        │ ◄── one row per video/photo file
      │ users        │
      │ comments     │
      │ media_reactions
      │ user_favorites
      │ settings     │ ◄── SMTP + app config (key/value)
      └──────────────┘

Background jobs (fire-and-forget after scan)
  enrichDurations()      ← ffprobe, concurrency 3
  generateMissingThumbs() ← ffmpeg/sharp, concurrency 3
```

**File map:**

```
xflix/
├── server.js           Entry point, boots Express, registers routers
├── db.js               mysql2 pool + all schema migrations + DB helpers
├── scanner.js          File walker, batch insert, thumb generation
├── cli.js              CLI wrapper: node cli.js scan / clear
│
├── routes/
│   ├── api.js          Public REST API (performers, media, search, stats…)
│   ├── auth.js         Register, login, JWT, password reset
│   ├── social.js       Comments, reactions, per-user favourites
│   ├── admin.js        Admin panel: scan, users, settings, duplicates, clean
│   └── stream.js       Video range streaming, photo serving, thumb serving
│
├── middleware/
│   └── auth.js         JWT middleware: optionalAuth, requireAuth, requireAdmin
│
├── services/
│   └── mail.js         Nodemailer transactional email (password reset)
│
├── public/             Static frontend (served as-is by Express)
│   ├── index.html      Single-page application shell
│   ├── css/style.css
│   └── js/app.js       Entire SPA logic (~1800 lines, no framework)
│
├── data/
│   └── thumbs/         Generated JPEG thumbnails (git-ignored, .gitkeep inside)
│
├── .env.example        All supported environment variables with docs
├── install.sh          One-shot install + PM2 launcher
└── package.json
```

---

## Requirements

| Component | Minimum | Notes |
|---|---|---|
| Linux | Ubuntu 20.04+ / Debian 11+ | Other distros work if you install deps manually |
| Node.js | 18.x | Installed automatically by `install.sh` via nvm |
| MariaDB | 10.5+ | MySQL 8.0+ also works |
| FFmpeg | any recent | Required for video thumbnails and duration extraction.<br>Installed automatically by `install.sh`. |
| sharp (npm) | — | Image processing library used for photo thumbnails; installed via `npm install` as a dependency |
| ffprobe | bundled with ffmpeg | Used by scanner to extract codec/fps/bitrate/audio info |
| RAM | 512 MB+ | More RAM = larger DB buffer pool |
| Disk | — | `data/thumbs/` grows ~10 KB per media item |

---

## Quick install

```bash
git clone https://github.com/HeartBtz/Xflix.git
cd Xflix
bash install.sh
```

`install.sh` does everything in one shot:

1. Installs **nvm** + **Node.js 20** if absent
2. Installs and starts **MariaDB** if absent
3. Installs **FFmpeg** if absent
4. Creates the `xflix` database and MariaDB user
5. Runs `npm install`
6. Copies `.env.example` → `.env` with sensible defaults (if `.env` is missing)
7. Creates the default `admin@xflix.local / xflix2026` account (if no users exist)
8. Starts the server via **PM2** and registers it for boot autostart

After install, open **http://localhost:3000** and launch a scan from ⚙️ Admin.

---

## Purging data (if you want a fresh install)

To completely wipe indexed data and thumbnails and start over:

```bash
# Truncate DB tables (keeps DB user) and rebuild schema
node cli.js clear

# Remove generated thumbnails (keeps data/thumbs/.gitkeep)
rm -f data/thumbs/* && touch data/thumbs/.gitkeep

# Optionally run a fresh scan
node cli.js scan
```

> **Tip:** To update an existing install, `git pull` and re-run `bash install.sh`.

---

## Manual install

### 1. System dependencies

```bash
sudo apt update
sudo apt install -y mariadb-server ffmpeg build-essential
sudo systemctl enable --now mariadb
```

### 2. MariaDB database

```bash
sudo mariadb -u root << 'SQL'
CREATE DATABASE IF NOT EXISTS xflix CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'xflix'@'localhost' IDENTIFIED BY 'xflix2026';
GRANT ALL PRIVILEGES ON xflix.* TO 'xflix'@'localhost';
FLUSH PRIVILEGES;
SQL
```

> Change `xflix2026` to a strong password and update `DB_PASS` in your `.env`.

### 3. Node.js via nvm

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm alias default 20
```

### 4. Clone and configure

```bash
git clone https://github.com/HeartBtz/Xflix.git
cd Xflix
npm install
cp .env.example .env
# Edit .env and set MEDIA_DIR, DB_PASS, JWT_SECRET at minimum
nano .env
```

### 5. Run

```bash
# Development (logs to stdout)
node server.js

# Production (via PM2, restarts on crash, survives reboots)
npm install -g pm2
pm2 start server.js --name xflix
pm2 save
pm2 startup   # follow the printed instructions to register with systemd
```

### 6. Scan your media

```bash
# From the CLI (server does not need to be running)
node cli.js scan

# Or from the browser: Admin → ▶ Lancer un scan
```

---

## Configuration reference

Copy `.env.example` to `.env` and adjust the values. All fields are optional
except those marked **required**.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port the server listens on |
| `MEDIA_DIR` | `/home/coder/OF` | **Required.** Absolute path to your media root.<br>Each immediate subdirectory becomes a performer. |
| `THUMB_DIR` | `<repo>/data/thumbs` | Where thumbnails are stored. |
| `DB_HOST` | `localhost` | MariaDB host |
| `DB_PORT` | `3306` | MariaDB port |
| `DB_USER` | `xflix` | MariaDB user |
| `DB_PASS` | `xflix2026` | **Change in production.** MariaDB password |
| `DB_NAME` | `xflix` | Database name |
| `JWT_SECRET` | *(weak default)* | **Change in production.** Long random string.<br>Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `JWT_EXPIRES` | `7d` | Token validity (e.g. `1h`, `30d`) |
| `BASE_URL` | `http://localhost:3000` | Used in password-reset emails |
| `SMTP_HOST` | — | SMTP server hostname (optional) |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |
| `SMTP_FROM` | — | Sender address shown in emails |
| `SMTP_SECURE` | `false` | `true` for SSL (port 465) |

SMTP can also be configured at runtime from **Admin → Settings** without
restarting the server — values are stored in the `settings` DB table.

---

## Directory layout

XFlix expects your media in a flat two-level structure:

```
MEDIA_DIR/
├── PerformerName/
│   ├── video1.mp4
│   ├── photo1.jpg
│   └── nested/
│       ├── video2.mkv
│       └── photo2.png
└── AnotherPerformer/
    └── …
```

- Each **immediate subdirectory** of `MEDIA_DIR` becomes one `performers` row.
- Media can be **nested at any depth** inside the performer directory.
- Supported video formats: `.mp4 .mkv .avi .mov .webm .wmv .flv .m4v .ts .3gp`
- Supported photo formats: `.jpg .jpeg .png .gif .webp .bmp .heic .heif .avif`

---

## How the scanner works

```
Admin → Scan
   │
   ├─ 1. Read all performer subdirectories from MEDIA_DIR
   ├─ 2. Load ALL existing file paths into memory (one query for all performers)
   ├─ 3. For each performer:
   │      a. Upsert the performers row
   │      b. Async-walk the directory tree (async generator, non-blocking)
   │      c. Skip already-indexed files (in-memory set lookup — O(1))
   │      d. stat() new files, accumulate into 500-row batches
   │      e. INSERT IGNORE batch into media table
   │      f. Send SSE progress event after each batch
   ├─ 4. UPDATE performer counts (video_count, photo_count, total_size)
   ├─ 5. Refresh random_cover_id for each performer
   │
   └─ Background (fire-and-forget, non-blocking for the client):
          enrichDurations(3)       → ffprobe each video that has no duration
          generateMissingThumbs()  → ffmpeg/sharp for recent media without a thumb
```

Scan is **incremental**: already-indexed files are skipped without touching the
DB. Running the scan again after adding new files is safe and fast.

---

## Thumbnail system

Thumbnails are stored in `data/thumbs/` with predictable names:
- Videos → `v_<media_id>.jpg`
- Photos → `p_<media_id>.jpg`

**On-demand generation** (`GET /thumb/:id`):

1. If `thumb_path` is already set in DB and the file exists → serve immediately (7-day cache).
2. Otherwise, attempt to generate: sharp (photos) or ffmpeg at 10% mark (videos).
3. A **semaphore** limits concurrent generation to 3 (configurable in `routes/stream.js`).
4. If the queue is full, the server responds `503 Retry-After: 4` instead of queuing
   indefinitely — this keeps browser connections free for API calls.
5. The frontend retries up to 4 times with exponential back-off (2s, 4s, 6s, 8s)
   before falling back to a lazy `<video>` element using the stream endpoint.

**Batch generation** runs automatically after every scan (last 300 media, concurrency 3).
It can also be triggered manually from **Admin → Générer les miniatures**.

---

## API reference

All endpoints return JSON. Error responses always include `{ "error": "..." }`.

### Performers

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/performers` | — | List performers. Query: `q`, `sort`, `order`, `favorite`, `minVideos`, `minPhotos`, `limit`, `offset` |
| GET | `/api/performers/:name` | — | Single performer by name |
| POST | `/api/performers/:id/favorite` | — | Toggle global favourite |

### Media

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/performers/:name/videos` | — | Paginated videos. Query: `sort`, `order`, `page`, `limit`, `minSize`, `maxSize`, `minDuration`, `maxDuration`, `favorite` |
| GET | `/api/performers/:name/photos` | — | Paginated photos. Query: `sort`, `order`, `page`, `limit`, `favorite` |
| GET | `/api/media/:id` | — | Single media record + performer name |
| POST | `/api/media/:id/favorite` | — | Toggle global favourite |
| POST | `/api/media/:id/view` | — | Increment view counter |

### Discovery

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/search` | — | Search across filename and performer name |
| GET | `/api/random/videos` | — | Random video sample (`limit` max 100) |
| GET | `/api/random/photos` | — | Random photo sample |
| GET | `/api/random/performer` | — | Random performer |
| GET | `/api/recent` | — | Recently viewed (`limit`, `type`) |
| GET | `/api/popular` | — | Most viewed (`limit`, `type`) |
| GET | `/api/favorites` | — | Globally favourited media |
| GET | `/api/stats` | — | Aggregate stats for the dashboard |

### Streaming

| Method | Path | Description |
|---|---|---|
| GET | `/stream/:id` | Video stream with Range / `206 Partial Content` |
| GET | `/photo/:id` | Full-size photo |
| GET | `/thumb/:id` | Thumbnail (generated on first request) |
| GET | `/download/:id` | Force-download with original filename |

### Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create account |
| POST | `/auth/login` | — | Returns JWT |
| GET | `/auth/me` | ✓ | Current user profile |
| PUT | `/auth/profile` | ✓ | Update username / bio |
| POST | `/auth/change-password` | ✓ | Change password |
| POST | `/auth/forgot-password` | — | Send reset email |
| POST | `/auth/reset-password` | — | Consume reset token |
| GET | `/auth/config` | — | Is registration open? |

### Social

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/social/comments/:mediaId` | — | Paginated comments |
| POST | `/social/comments/:mediaId` | ✓ | Post a comment |
| PATCH | `/social/comments/:id` | ✓ | Edit own comment |
| DELETE | `/social/comments/:id` | ✓ | Delete own comment |
| GET | `/social/reactions/:mediaId` | — | Like/dislike counts |
| POST | `/social/reactions/:mediaId` | ✓ | Add / toggle reaction |
| GET | `/social/favorites` | ✓ | User's personal favourites |
| POST | `/social/favorites/:mediaId` | ✓ | Toggle personal favourite |
| GET | `/social/favorites/:mediaId` | ✓ | Check if favourited |

### Admin (all require `role=admin`)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/stats` | Dashboard counts |
| GET/PATCH/DELETE | `/admin/users/*` | User management |
| GET/PUT | `/admin/settings` | App settings (SMTP…) |
| POST | `/admin/settings/test-smtp` | Test SMTP |
| POST | `/admin/scan` | **SSE** — scan with live progress |
| POST | `/admin/scan/cancel` | Cancel in-progress scan |
| POST | `/admin/batch-thumbs` | **SSE** — batch thumbnail generation |
| GET | `/admin/media` | Media browser |
| DELETE | `/admin/media/:id` | Delete media DB record (+ optional disk) |
| POST | `/admin/duplicates/scan` | **SSE** — hash-based dup detection |
| POST | `/admin/duplicates/delete-bulk` | **SSE** — bulk delete |
| DELETE | `/admin/duplicates/:id` | Delete one duplicate |
| POST | `/admin/clean-media` | **SSE** — orphan/unindexed scan |
| POST | `/admin/purge-short-videos` | **SSE** — delete short videos |

> **SSE endpoints** stream `data: {...}\n\n` events. The last event always has
> `status: "done"` or `status: "error"`.

---

## Admin panel

Access the admin panel by clicking the ⚙️ icon (only visible if logged in as admin).

| Tab | What it does |
|---|---|
| **Scan** | Index new media files. Progress shown live. |
| **Miniatures** | Generate thumbnails for media that don't have one yet. |
| **Doublons** | Detect duplicate files using fast partial hashing. |
| **Nettoyage** | Find orphaned DB records, unindexed disk files, stale thumbs. |
| **Purge** | Delete videos shorter than a configurable duration. |
| **Médias** | Browse, search and delete individual media records. |
| **Utilisateurs** | Manage user accounts and roles. |
| **Paramètres** | Configure SMTP, toggle open registration. |

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `←` / `→` | Previous / next in lightbox or video player |
| `F` | Toggle favourite on current media |
| `D` | Download current media |
| `Escape` | Close lightbox / player |
| `Space` | Play / pause video |

---

## Troubleshooting

### Server won't start — "DB error"

```bash
# Check MariaDB is running
sudo systemctl status mariadb

# Test credentials
mariadb -u xflix -p xflix

# Tail PM2 logs
pm2 logs xflix --lines 50
```

### "Failed to fetch" errors in the browser

This almost always means the server dropped a connection. Common causes:

| Symptom | Cause | Fix |
|---|---|---|
| Only when loading a performer for the first time | All 6 browser connections consumed by concurrent thumbnail generation | Already fixed (semaphore + retry logic in v1.2). Make sure you're on the latest version. |
| After running a scan | `enrichDurations` + `generateMissingThumbs` saturating the DB pool | Wait 1–2 minutes for background jobs to finish. |
| FFmpeg not installed | Video thumbnails all return 404 → `onerror` fallback opened 50 streams | Run `sudo apt install ffmpeg` and restart the server. |
| Repeated crashes | Unhandled exception in a route | Check `pm2 logs xflix --err` |

### Video thumbnails are all missing / black

```bash
# Check ffmpeg is installed
which ffmpeg && ffmpeg -version

# If absent:
sudo apt install ffmpeg
pm2 restart xflix
```

### Photos have no thumbnails

The `sharp` npm package requires native bindings compiled for your platform.
If `npm install` didn't build it:

```bash
npm rebuild sharp
pm2 restart xflix
```

### Scan is very slow

- For 60 000+ files the scan can take 30–60 seconds. This is normal.
- The async walker is non-blocking — the UI stays responsive during the scan.
- Check `pm2 logs xflix` for `[SCANNER ERROR]` messages.

### PM2 process keeps restarting

```bash
pm2 logs xflix --err --lines 100
# Look for uncaughtException or unhandledRejection messages
```

---

## Contributing

1. Fork the repo and create a feature branch: `git checkout -b feat/my-feature`
2. Make your changes. Keep each commit focused and descriptive.
3. Test manually: start the server, run a scan, open a performer, check the admin panel.
4. Open a pull request against `main` with a clear description of what changed and why.

### Code conventions

- **Backend**: Node.js 18+, CommonJS modules, async/await throughout.
  All DB access goes through `db.js` helpers. Route handlers are `async (req, res) => {}` with a top-level `try/catch`.
- **Frontend**: Vanilla JS, no framework, no build step. One file (`public/js/app.js`).
  State lives in the `state` object. DOM helpers `$()` and `$q()` are defined at the top.
- **Comments**: File-level JSDoc header on every `.js` file. Inline comments for non-obvious logic.
- **SQL**: Always use parameterised queries (`pool.query('… WHERE id = ?', [id])`).
  Column names in `ORDER BY` are validated against an allowlist before interpolation.

### Environment setup

```bash
git clone https://github.com/HeartBtz/Xflix.git
cd Xflix
npm install
cp .env.example .env   # fill in DB_PASS, JWT_SECRET, MEDIA_DIR
node server.js         # or: npm run dev  (auto-restart via nodemon)
```

---

## License

MIT — © HeartBtz
