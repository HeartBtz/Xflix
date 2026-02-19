/* ═══════════════════════════════════════════════════════════════
   XFlix — Frontend Application (Enhanced)
   ═══════════════════════════════════════════════════════════════ */

const API = '/api';

/* ── State ─────────────────────────────────────────────────────── */
const state = {
  performers: [],
  currentPerformer: null,
  videos: [],
  photos: [],
  videoPage: 1,
  videoTotal: 0,
  videoLimit: 50,
  photoPage: 1,
  photoTotal: 0,
  photoLimit: 100,
  lightboxIndex: 0,
  videoIndex: 0,
  scanInterval: null,
  currentFilter: 'all',
  currentPage: 'home',
  discoverVideos: [],
  discoverPhotos: [],
};

/* ── DOM Helpers ────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const $q = sel => document.querySelector(sel);
const $qa = sel => document.querySelectorAll(sel);

/* ── Global lazy-loader for video[data-src] thumbnails ──────────
 * Used by makeVideoThumb (fallback when thumb generation fails).
 * Observes any video[data-src] elements added to the DOM at any
 * time, including those injected by handleThumbError.
 * ─────────────────────────────────────────────────────────────── */
const videoThumbObserver = new IntersectionObserver((entries, obs) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const vid = entry.target;
    if (vid.dataset.src) { vid.src = vid.dataset.src; delete vid.dataset.src; }
    obs.unobserve(vid);
  });
}, { rootMargin: '300px' });

/* ── Utilities ──────────────────────────────────────────────────── */
function formatSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function formatDuration(secs) {
  if (!secs) return '';
  secs = Math.floor(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function formatNumber(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n/1000).toFixed(1) + 'K';
  return String(n);
}

async function apiFetch(url, retries = 3, delay = 400) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { headers: authHeaders() });
      // Retry on 503 (Busy — server overloaded with thumb generation)
      if (r.status === 503 && attempt < retries) {
        await new Promise(res => setTimeout(res, delay * attempt));
        continue;
      }
      if (!r.ok) throw new Error(`API error ${r.status}`);
      return await r.json();
    } catch(e) {
      if (attempt === retries) throw e;
      // Retry on network errors (Failed to fetch, NetworkError)
      if (e instanceof TypeError) {
        await new Promise(res => setTimeout(res, delay * attempt));
      } else {
        throw e; // erreur applicative (4xx, 5xx) → pas de retry
      }
    }
  }
}

async function apiPost(url) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() } });
  if (!r.ok) throw new Error(`API error ${r.status}`);
  return r.json();
}

function showToast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast hidden'; }, 3000);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Creates a lazy video element to use as thumbnail fallback.
// Uses data-src + global IntersectionObserver to load the stream
// only when the card scrolls into view.
function makeVideoThumb(id) {
  const v = document.createElement('video');
  v.dataset.src = `/stream/${id}#t=5`;
  v.preload = 'metadata';
  v.muted = true;
  v.playsInline = true;
  v.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none';
  videoThumbObserver.observe(v);
  return v;
}

// Handles thumbnail load error: retries a few times (server may be busy
// generating the thumb) before falling back to a lazy video stream element.
function handleThumbError(img, id) {
  const retries = (img._thumbRetries || 0) + 1;
  img._thumbRetries = retries;
  if (retries <= 4) {
    // Retry with back-off: 2s, 4s, 6s, 8s — avoids hammering the server
    setTimeout(() => {
      if (img.isConnected) img.src = `/thumb/${id}?r=${retries}`;
    }, retries * 2000);
  } else {
    // Give up: display lazy video stream as fallback
    if (img.isConnected) img.replaceWith(makeVideoThumb(id));
  }
}

/* ── Navigation ─────────────────────────────────────────────────── */
function showPage(id) {
  $qa('.page').forEach(p => p.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);

  // Update nav links
  const pageMap = { homePage: 'home', favoritesPage: 'favorites', discoverPage: 'discover', performerPage: null };
  $qa('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page === pageMap[id]));
}

/* ══════════════════════════════════════════════════════════════════
   HOME PAGE
   ══════════════════════════════════════════════════════════════════ */

async function loadHeroStats() {
  try {
    const s = await apiFetch(`${API}/stats`);
    $('heroStats').innerHTML = [
      { v: s.performers, l: 'Performeuses' },
      { v: formatNumber(s.videos), l: 'Vidéos' },
      { v: formatNumber(s.photos), l: 'Photos' },
      { v: formatSize(s.totalSize), l: 'Total' },
    ].map(x => `<div class="hero-stat"><span class="hero-stat-value">${x.v}</span><span class="hero-stat-label">${x.l}</span></div>`).join('');
  } catch(e) {}
}

async function loadPerformers(params = {}) {
  const grid = $('performersGrid');
  grid.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Chargement…</p></div>';

  const [sort, order = 'asc'] = (params.sort || 'name').split('|');
  const qs = new URLSearchParams({
    sort, order,
    ...(params.q          ? { q: params.q }                : {}),
    ...(params.minVideos  ? { minVideos: params.minVideos } : {}),
    ...(params.minPhotos  ? { minPhotos: params.minPhotos } : {}),
    ...(params.favorite   ? { favorite: '1' }              : {}),
  });

  try {
    const { data, total } = await apiFetch(`${API}/performers?${qs}`);
    state.performers = data;
    $('performerCount').textContent = `${total} performeuse${total > 1 ? 's' : ''}`;
    $('sectionTitle').textContent = params.q ? `Résultats pour « ${params.q} »` : (params.favorite ? '⭐ Performeuses favorites' : 'Toutes les performeuses');
    renderPerformers(data);
  } catch(e) {
    grid.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><h3>Erreur de chargement</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderPerformers(performers) {
  const grid = $('performersGrid');
  if (!performers.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🎭</span>
        <h3>Aucune performeuse trouvée</h3>
        <p>Lancez un scan via <strong>⚙️</strong> pour indexer vos médias.</p>
      </div>`;
    return;
  }

  grid.innerHTML = performers.map(p => {
    const initials = p.name.slice(0, 2).toUpperCase();
    // Use random_cover_id for variety on each page load, fallback to cover_media_id
    const thumbSrc = (p.random_cover_id || p.cover_media_id) ? `/thumb/${p.random_cover_id || p.cover_media_id}` : '';
    return `
      <div class="performer-card" data-name="${escapeHtml(p.name)}" onclick="openPerformer('${encodeURIComponent(p.name)}')">
        <div class="performer-thumb-wrap">
          ${thumbSrc
            ? `<img class="performer-thumb" data-src="${thumbSrc}" alt="${escapeHtml(p.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.style.display='flex')">
               <div class="performer-thumb-placeholder" style="display:none"><div style="font-size:2.2rem;font-weight:900;color:var(--text-dim)">${initials}</div><span>${escapeHtml(p.name)}</span></div>`
            : `<div class="performer-thumb-placeholder"><div style="font-size:2.2rem;font-weight:900;color:var(--text-dim)">${initials}</div><span>${escapeHtml(p.name)}</span></div>`
          }
        </div>
        <div class="performer-card-info">
          <div class="performer-card-name">${escapeHtml(p.name)}</div>
          <div class="performer-card-stats">
            ${p.video_count ? `<span class="stat-chip chip-video">▶ ${p.video_count}</span>` : ''}
            ${p.photo_count ? `<span class="stat-chip chip-photo">🖼 ${p.photo_count}</span>` : ''}
            ${p.total_size  ? `<span class="stat-chip chip-size">${formatSize(p.total_size)}</span>` : ''}
            ${p.favorite    ? `<span class="stat-chip chip-fav">❤️</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  // IntersectionObserver: only start loading images when card enters viewport
  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const img = entry.target;
      if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
      obs.unobserve(img);
    });
  }, { rootMargin: '200px' });

  grid.querySelectorAll('img[data-src]').forEach(img => io.observe(img));
}

/* ── Search ─────────────────────────────────────────────────────── */
let searchDebounce;
$('searchInput').addEventListener('input', e => {
  clearTimeout(searchDebounce);
  const v = e.target.value.trim();
  searchDebounce = setTimeout(() => {
    if (state.currentPage !== 'home') {
      showPage('homePage');
      state.currentPage = 'home';
    }
    loadPerformers(getSortParams());
  }, 300);
});

$('searchClear').addEventListener('click', () => {
  $('searchInput').value = '';
  loadPerformers(getSortParams());
});

function getSortParams() {
  const params = {
    sort: $('sortPerformers').value,
    q: $('searchInput').value.trim() || undefined,
  };
  if (state.currentFilter === 'favorites') params.favorite = true;
  if (state.currentFilter === 'hasVideos') params.minVideos = '1';
  if (state.currentFilter === 'hasPhotos') params.minPhotos = '1';
  return params;
}

$('sortPerformers').addEventListener('change', () => {
  localStorage.setItem('xflix_sort_performers', $('sortPerformers').value);
  loadPerformers(getSortParams());
});

/* ── Filter Chips ───────────────────────────────────────────────── */
$qa('.chip[data-filter]').forEach(chip => {
  chip.addEventListener('click', () => {
    $qa('.chip[data-filter]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.currentFilter = chip.dataset.filter;
    loadPerformers(getSortParams());
  });
});

/* ── Nav Links ──────────────────────────────────────────────────── */
$('navBrand').addEventListener('click', () => {
  state.currentPage = 'home';
  showPage('homePage');
  loadPerformers(getSortParams());
});

$qa('.nav-link').forEach(link => {
  link.addEventListener('click', () => {
    const page = link.dataset.page;
    state.currentPage = page;
    if (page === 'home') { showPage('homePage'); loadPerformers(getSortParams()); }
    else if (page === 'favorites') { showPage('favoritesPage'); loadFavoritesPage(); }
    else if (page === 'discover') { showPage('discoverPage'); loadDiscoverPage(); }
    else if (page === 'new') { showPage('newPage'); loadNewPage(); }
  });
});

$('navHome').addEventListener('click', () => {
  state.currentPage = 'home';
  showPage('homePage');
  loadPerformers(getSortParams());
});

/* ── Hero Buttons ───────────────────────────────────────────────── */
$('heroShuffle').addEventListener('click', () => {
  $('navDiscover').click();
});

$('heroManage').addEventListener('click', () => {
  if (!auth.user || auth.user.role !== 'admin') {
    showToast('Accès réservé aux administrateurs', 'error');
    openAuthModal('loginForm');
    return;
  }
  $('btnManage').click();
});

/* ══════════════════════════════════════════════════════════════════
   FAVORITES PAGE
   ══════════════════════════════════════════════════════════════════ */

let currentFavTab = 'fav-videos';

$qa('[data-ftab]').forEach(t => {
  t.addEventListener('click', () => {
    $qa('[data-ftab]').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    currentFavTab = t.dataset.ftab;
    loadFavoritesPage();
  });
});

async function loadFavoritesPage() {
  const container = $('favContent');
  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  try {
    if (currentFavTab === 'fav-videos') {
      const { data } = await apiFetch(`${API}/favorites?type=video&limit=100`);
      if (!data.length) { container.innerHTML = '<div class="empty-state"><span class="empty-icon">🎬</span><h3>Aucune vidéo favorite</h3><p>Cliquez sur ❤️ pour ajouter des vidéos à vos favoris.</p></div>'; return; }
      state.videos = data;
      container.innerHTML = '<div class="media-grid videos-grid" id="favVideosGrid"></div>';
      renderVideoCards(data, $('favVideosGrid'), true);
    } else if (currentFavTab === 'fav-photos') {
      const { data } = await apiFetch(`${API}/favorites?type=photo&limit=200`);
      if (!data.length) { container.innerHTML = '<div class="empty-state"><span class="empty-icon">🖼️</span><h3>Aucune photo favorite</h3></div>'; return; }
      state.photos = data;
      container.innerHTML = '<div class="media-grid photos-grid" id="favPhotosGrid"></div>';
      renderPhotoCards(data, $('favPhotosGrid'));
    } else {
      const { data } = await apiFetch(`${API}/performers?favorite=1`);
      if (!data.length) { container.innerHTML = '<div class="empty-state"><span class="empty-icon">🎭</span><h3>Aucune performeuse favorite</h3></div>'; return; }
      container.innerHTML = '<div class="performers-grid" id="favPerfGrid"></div>';
      state.performers = data;
      renderPerformersInGrid(data, $('favPerfGrid'));
    }
  } catch(e) {
    container.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><h3>Erreur</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderPerformersInGrid(performers, grid) {
  grid.innerHTML = performers.map(p => {
    const initials = p.name.slice(0, 2).toUpperCase();
    const thumbSrc = (p.random_cover_id || p.cover_media_id) ? `/thumb/${p.random_cover_id || p.cover_media_id}` : '';
    return `
      <div class="performer-card" onclick="openPerformer('${encodeURIComponent(p.name)}')">
        <div class="performer-thumb-wrap">
          ${thumbSrc
            ? `<img class="performer-thumb" src="${thumbSrc}" alt="${escapeHtml(p.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.style.display='flex')">
               <div class="performer-thumb-placeholder" style="display:none"><div style="font-size:2.2rem;font-weight:900;color:var(--text-dim)">${initials}</div><span>${escapeHtml(p.name)}</span></div>`
            : `<div class="performer-thumb-placeholder"><div style="font-size:2.2rem;font-weight:900;color:var(--text-dim)">${initials}</div><span>${escapeHtml(p.name)}</span></div>`
          }
        </div>
        <div class="performer-card-info">
          <div class="performer-card-name">${escapeHtml(p.name)}</div>
          <div class="performer-card-stats">
            ${p.video_count ? `<span class="stat-chip chip-video">▶ ${p.video_count}</span>` : ''}
            ${p.photo_count ? `<span class="stat-chip chip-photo">🖼 ${p.photo_count}</span>` : ''}
            <span class="stat-chip chip-fav">❤️</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════════
   DISCOVER PAGE
   ══════════════════════════════════════════════════════════════════ */

async function loadDiscoverPage() {
  $('randomVideosGrid').innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  $('randomPhotosGrid').innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  if ($('newMediaGrid')) $('newMediaGrid').innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  try {
    const [vRes, pRes, newRes] = await Promise.all([
      apiFetch(`${API}/random/videos?limit=12`),
      apiFetch(`${API}/random/photos?limit=24`),
      apiFetch(`${API}/new?type=video&limit=12`),
    ]);

    state.discoverVideos = vRes.data;
    state.discoverPhotos = pRes.data;
    state.videos = vRes.data;
    state.photos = pRes.data;

    if (vRes.data.length) renderVideoCards(vRes.data, $('randomVideosGrid'), true);
    else $('randomVideosGrid').innerHTML = '<div class="empty-state"><span class="empty-icon">🎬</span><h3>Aucune vidéo</h3></div>';

    if (pRes.data.length) renderPhotoCards(pRes.data, $('randomPhotosGrid'));
    else $('randomPhotosGrid').innerHTML = '<div class="empty-state"><span class="empty-icon">🖼️</span><h3>Aucune photo</h3></div>';

    if ($('newMediaGrid')) {
      if (newRes.data.length) renderVideoCards(newRes.data, $('newMediaGrid'), true);
      else $('newMediaGrid').innerHTML = '<div class="empty-state"><span class="empty-icon">🆕</span><h3>Aucune nouveauté</h3></div>';
    }
  } catch(e) {
    $('randomVideosGrid').innerHTML = `<div class="empty-state"><p>Lancez un scan d'abord</p></div>`;
    $('randomPhotosGrid').innerHTML = '';
  }
}

$('reshuffleBtn').addEventListener('click', loadDiscoverPage);

/* ══════════════════════════════════════════════════════════════════
   PERFORMER PAGE
   ══════════════════════════════════════════════════════════════════ */

async function openPerformer(encodedName) {
  const name = decodeURIComponent(encodedName);
  showPage('performerPage');
  state.currentPage = 'performer';

  $('performerName').textContent = name;
  $('performerMeta').innerHTML = '<div class="loading-spinner" style="padding:4px 0"><div class="spinner" style="width:18px;height:18px;border-width:2px"></div></div>';

  try {
    const p = await apiFetch(`${API}/performers/${encodeURIComponent(name)}`);
    state.currentPerformer = p;
    $('performerMeta').innerHTML = `
      ${p.video_count ? `<span class="stat-chip chip-video">▶ ${p.video_count} vidéo${p.video_count>1?'s':''}</span>` : ''}
      ${p.photo_count ? `<span class="stat-chip chip-photo">🖼 ${p.photo_count} photo${p.photo_count>1?'s':''}</span>` : ''}
      ${p.total_size  ? `<span class="stat-chip chip-size">${formatSize(p.total_size)}</span>` : ''}
      ${p.totalViews  ? `<span class="performer-stat-chip">👁 ${formatNumber(p.totalViews)} vue${p.totalViews>1?'s':''}</span>` : ''}
      ${p.totalDuration ? `<span class="performer-stat-chip">⏱ ${formatDuration(p.totalDuration)}</span>` : ''}
    `;
    $('tabVideoCount').textContent = `Vidéos (${p.video_count})`;
    $('tabPhotoCount').textContent = `Photos (${p.photo_count})`;

    // Set favorite button
    const favBtn = $('btnFavPerformer');
    favBtn.textContent = p.favorite ? '❤️' : '♡';
    favBtn.classList.toggle('active', !!p.favorite);
  } catch(e) {
    $('performerMeta').textContent = 'Erreur lors du chargement';
  }

  // Load tag filter scoped to this performer + reset selection
  const tagSel = $('filterVideoTag');
  if (tagSel) tagSel.value = '';
  loadVideoTagFilter(name);
  switchTab('videos');
}

function switchTab(tab) {
  $qa('.tab[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const isVideo = tab === 'videos';
  $('videoTab').classList.toggle('hidden', !isVideo);
  $('photoTab').classList.toggle('hidden', isVideo);
  $('videoFilters').classList.toggle('hidden', !isVideo);
  $('photoFilters').classList.toggle('hidden', isVideo);

  if (isVideo) loadVideos();
  else loadPhotos();
}

$qa('.tab[data-tab]').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

/* ── Performer Favorite ─────────────────────────────────────────── */
$('btnFavPerformer').addEventListener('click', async () => {
  if (!state.currentPerformer) return;
  try {
    const res = await apiPost(`${API}/performers/${state.currentPerformer.id}/favorite`);
    state.currentPerformer.favorite = res.favorite;
    const btn = $('btnFavPerformer');
    btn.textContent = res.favorite ? '❤️' : '♡';
    btn.classList.toggle('active', !!res.favorite);
    showToast(res.favorite ? 'Ajoutée aux favoris ❤️' : 'Retirée des favoris', 'success');
  } catch(e) { showToast('Erreur', 'error'); }
});

/* ── Videos ─────────────────────────────────────────────────────── */
async function loadVideos(page = 1, append = false) {
  state.videoPage = page;
  const grid = $('videosGrid');
  if (!append) grid.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Chargement…</p></div>';

  const [sort, order = 'asc'] = $('sortVideos').value.split('|');
  const qs = new URLSearchParams({
    sort, order, page, limit: state.videoLimit,
    ...($('filterVideoMinSize').value ? { minSize: $('filterVideoMinSize').value } : {}),
    ...($('filterVideoMaxSize').value ? { maxSize: $('filterVideoMaxSize').value } : {}),
    ...($('filterVideoMinDur').value  ? { minDuration: $('filterVideoMinDur').value }  : {}),
    ...($('filterVideoMaxDur').value  ? { maxDuration: $('filterVideoMaxDur').value }  : {}),
    ...($('filterFavVideos').checked  ? { favorite: '1' } : {}),
    ...($('filterVideoTag') && $('filterVideoTag').value ? { tag: $('filterVideoTag').value } : {}),
  });

  try {
    const { data, total } = await apiFetch(
      `${API}/performers/${encodeURIComponent(state.currentPerformer.name)}/videos?${qs}`
    );
    if (append) {
      state.videos = [...state.videos, ...data];
    } else {
      state.videos = data;
    }
    state.videoTotal = total;

    if (append && data.length) {
      const tmp = document.createElement('div');
      tmp.innerHTML = data.map(v => renderSingleVideoCard(v, false)).join('');
      while (tmp.firstChild) grid.appendChild(tmp.firstChild);
    } else {
      renderVideoCards(data, grid, false);
    }

    const totalPages = Math.ceil(total / state.videoLimit);
    const sentinel = $('videoScrollSentinel');
    if (sentinel) sentinel.classList.toggle('hidden', page >= totalPages);
    renderPagination('videoPagination', page, totalPages, p => loadVideos(p));
  } catch(e) {
    if (!append) grid.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><h3>Erreur</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderSingleVideoCard(v, showPerformer = false) {
  const tagCls = { '4K': 'tag-4k', '1080p': 'tag-hd', '720p': 'tag-hd', 'Long': 'tag-long' };
  const tagsHtml = v.tags && v.tags.length
    ? `<div class="video-tags">${v.tags.map(t => `<span class="tag-badge ${tagCls[t] || ''}">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';
  return `
    <div class="video-card" onclick="openVideoById(${v.id})">
      <div class="video-thumb-wrapper">
        <img src="/thumb/${v.id}" alt="${escapeHtml(v.filename)}" loading="lazy"
          onerror="handleThumbError(this,${v.id})"
          style="width:100%;height:100%;object-fit:cover;display:block">
        <div class="play-overlay"><div class="play-btn">▶</div></div>
        ${v.duration ? `<div class="video-duration">${formatDuration(v.duration)}</div>` : ''}
        ${v.favorite ? '<div class="video-fav-badge">❤️</div>' : ''}
      </div>
      <div class="video-card-info">
        ${showPerformer && v.performer_name ? `<div class="video-card-performer">${escapeHtml(v.performer_name)}</div>` : ''}
        <div class="video-card-name" title="${escapeHtml(v.filename)}">${escapeHtml(v.filename)}</div>
        <div class="video-card-meta">
          <span>${formatSize(v.size)}</span>
          ${v.duration ? `<span>${formatDuration(v.duration)}</span>` : ''}
          ${v.view_count ? `<span>👁 ${v.view_count}</span>` : ''}
        </div>
        ${tagsHtml}
      </div>
    </div>
  `;
}

function renderVideoCards(videos, grid, showPerformer = false) {
  if (!videos.length) {
    grid.innerHTML = `<div class="empty-state"><span class="empty-icon">🎬</span><h3>Aucune vidéo</h3></div>`;
    return;
  }
  grid.innerHTML = videos.map(v => renderSingleVideoCard(v, showPerformer)).join('');
}

$('sortVideos').addEventListener('change', () => {
  localStorage.setItem('xflix_sort_videos', $('sortVideos').value);
  loadVideos(1);
});
$('filterFavVideos').addEventListener('change', () => loadVideos(1));
if ($('filterVideoTag')) $('filterVideoTag').addEventListener('change', () => loadVideos(1));

// Auto-apply filters on change
['filterVideoMinSize','filterVideoMaxSize','filterVideoMinDur','filterVideoMaxDur'].forEach(id => {
  $(id).addEventListener('change', () => loadVideos(1));
});

// Populate tag filter dropdown from API.
// If performerName is given, scopes tag counts to that performer.
async function loadVideoTagFilter(performerName) {
  try {
    const qs = performerName ? `?performer=${encodeURIComponent(performerName)}` : '';
    const { data } = await apiFetch(`${API}/tags${qs}`);
    const sel = $('filterVideoTag');
    if (!sel) return;
    sel.innerHTML = '<option value="">Tous</option>';
    data.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = `${t.name} (${t.count})`;
      sel.appendChild(opt);
    });
  } catch(e) { /* ignore if no tags yet */ }
}

// Infinite scroll observer on sentinel (debounced / guarded)
let _scrollLoading = false;
const videoScrollObserver = new IntersectionObserver((entries) => {
  if (!entries[0].isIntersecting || state.currentPage !== 'performer') return;
  if (_scrollLoading) return; // already loading
  const totalPages = Math.ceil((state.videoTotal || 0) / state.videoLimit);
  if (state.videoPage >= totalPages) return;
  _scrollLoading = true;
  loadVideos(state.videoPage + 1, true).finally(() => { _scrollLoading = false; });
}, { rootMargin: '200px' });

const _sentinel = $('videoScrollSentinel');
if (_sentinel) videoScrollObserver.observe(_sentinel);

/* ── Photos ─────────────────────────────────────────────────────── */
async function loadPhotos(page = 1) {
  state.photoPage = page;
  const grid = $('photosGrid');
  grid.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Chargement…</p></div>';

  const [sort, order = 'asc'] = $('sortPhotos').value.split('|');
  const qs = new URLSearchParams({
    sort, order, page, limit: state.photoLimit,
    ...($('filterFavPhotos').checked ? { favorite: '1' } : {}),
  });

  try {
    const { data, total } = await apiFetch(
      `${API}/performers/${encodeURIComponent(state.currentPerformer.name)}/photos?${qs}`
    );
    state.photos = data;
    state.photoTotal = total;
    renderPhotoCards(data, grid);
    renderPagination('photoPagination', page, Math.ceil(total / state.photoLimit), p => loadPhotos(p));
  } catch(e) {
    grid.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><h3>Erreur</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderPhotoCards(photos, grid) {
  if (!photos.length) {
    grid.innerHTML = `<div class="empty-state"><span class="empty-icon">🖼️</span><h3>Aucune photo</h3></div>`;
    return;
  }

  grid.innerHTML = photos.map((ph, idx) => `
    <div class="photo-card" onclick="openPhoto(${idx})">
      <img src="/thumb/${ph.id}" alt="${escapeHtml(ph.filename)}" loading="lazy"
        onerror="this.src='/photo/${ph.id}'" />
      <div class="photo-overlay">${escapeHtml(ph.filename)}</div>
    </div>
  `).join('');
}

$('sortPhotos').addEventListener('change', () => {
  localStorage.setItem('xflix_sort_photos', $('sortPhotos').value);
  loadPhotos(1);
});
$('filterFavPhotos').addEventListener('change', () => loadPhotos(1));

/* ── Pagination ─────────────────────────────────────────────────── */
function renderPagination(containerId, current, totalPages, onPage) {
  const el = $(containerId);
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const pages = [];
  const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);

  if (totalPages <= 7) {
    pages.push(...range(1, totalPages));
  } else {
    pages.push(1);
    if (current > 3) pages.push('…');
    pages.push(...range(Math.max(2, current - 1), Math.min(totalPages - 1, current + 1)));
    if (current < totalPages - 2) pages.push('…');
    pages.push(totalPages);
  }

  el.innerHTML = `
    <button class="page-btn" ${current===1?'disabled':''} onclick="(${onPage})(${current-1})">‹</button>
    ${pages.map(p => p === '…'
      ? `<span class="page-btn" style="cursor:default">…</span>`
      : `<button class="page-btn ${p===current?'active':''}" onclick="(${onPage})(${p})">${p}</button>`
    ).join('')}
    <button class="page-btn" ${current===totalPages?'disabled':''} onclick="(${onPage})(${current+1})">›</button>
  `;
}

/* ── Back button ─────────────────────────────────────────────────── */
$('btnBack').addEventListener('click', () => {
  showPage('homePage');
  state.currentPage = 'home';
  loadPerformers(getSortParams());
});

/* ══════════════════════════════════════════════════════════════════
   VIDEO PLAYER — Cinema Mode
   ══════════════════════════════════════════════════════════════════ */

// Resume positions: mediaId → seconds
const resumeMap = {};
let uiHideTimer = null;

function showPlayerUI() {
  const modal = $q('.video-modal');
  if (!modal) return;
  modal.classList.add('vp-show-ui');
  clearTimeout(uiHideTimer);
  const player = $('videoPlayer');
  if (player && !player.paused) {
    uiHideTimer = setTimeout(() => modal.classList.remove('vp-show-ui'), 2500);
  }
}

function openVideo(idx) {
  state.videoIndex = idx;
  const v = state.videos[idx];
  if (!v) return;
  const player = $('videoPlayer');

  $('videoTitle').textContent = v.filename;

  // Build tech info meta row
  const metaParts = [
    formatSize(v.size),
    v.duration ? formatDuration(v.duration) : '',
    v.performer_name || '',
  ];
  if (v.codec && v.codec !== 'h264') metaParts.push(v.codec.toUpperCase());
  if (v.fps && v.fps > 0) metaParts.push(`${Math.round(v.fps)} fps`);
  if (v.bitrate && v.bitrate > 0) metaParts.push(`${Math.round(v.bitrate / 1000)} kbps`);
  if (v.audio_codec && v.audio_codec !== 'aac') metaParts.push(v.audio_codec.toUpperCase());
  if (v.audio_sample_rate && v.audio_sample_rate > 0) metaParts.push(`${Math.round(v.audio_sample_rate / 1000)} kHz`);
  $('videoMeta').textContent = metaParts.filter(Boolean).join(' · ');

  // Set favorite button
  const favBtn = $('favCurrentVideo');
  favBtn.textContent = v.favorite ? '❤️' : '♡';
  favBtn.classList.toggle('active', !!v.favorite);
  favBtn.dataset.id = v.id;

  // Reset controls
  $('vpPlayed').style.width = '0%';
  $('vpBuffered').style.width = '0%';
  $('vpTime').textContent = '0:00 / 0:00';
  $('vpPlayPause').textContent = '▶';
  $('vpOverlay').classList.add('paused');
  $('vpSpeed').value = '1';

  player.src = `/stream/${v.id}`;
  player.playbackRate = 1;
  player.load();

  // Set download link
  const dlBtn = $('vpDownload');
  if (dlBtn) { dlBtn.href = `/download/${v.id}`; dlBtn.setAttribute('download', v.filename || ''); }

  // Resume from saved position
  player.addEventListener('loadedmetadata', function onMeta() {
    player.removeEventListener('loadedmetadata', onMeta);
    if (resumeMap[v.id] && resumeMap[v.id] > 2 && resumeMap[v.id] < player.duration - 5) {
      player.currentTime = resumeMap[v.id];
    }
    player.play().catch(() => {});
  });

  $('videoModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  $('videoPrev').disabled = idx === 0;
  $('videoNext').disabled = idx === state.videos.length - 1;

  showPlayerUI();

  // Track view
  apiPost(`${API}/media/${v.id}/view`).catch(() => {});

  // Load reactions + reset comments
  loadReactions(v.id).catch(() => {});
  commentsMediaId = v.id;
  commentsPage = 1;
  $('commentsList').innerHTML = '';
  $('commentsBody').classList.add('hidden');
  $('commentsToggle').textContent = 'Afficher';

  // Load related videos from same performer
  loadRelatedVideos(v.id);
}

function closeVideoModal() {
  const player = $('videoPlayer');
  // Save position for resume
  const v = state.videos[state.videoIndex];
  if (v && player.currentTime > 2) {
    resumeMap[v.id] = player.currentTime;
  }
  player.pause();
  player.removeAttribute('src');
  player.load();
  $('videoModal').classList.add('hidden');
  document.body.style.overflow = '';
  clearTimeout(uiHideTimer);
  // Hide related when closing
  const vpRel = $('vpRelated');
  if (vpRel) vpRel.classList.add('hidden');
}

/**
 * Fetch and render related videos (same performer) in the player sidebar.
 * @param {number} mediaId
 */
async function loadRelatedVideos(mediaId) {
  const el = $('vpRelated');
  const grid = $('vpRelatedGrid');
  if (!el || !grid) return;
  el.classList.add('hidden');
  try {
    const { data } = await apiFetch(`${API}/media/${mediaId}/related?limit=8`);
    if (!data.length) return;
    el.classList.remove('hidden');
    grid.innerHTML = data.map(r => `
      <div class="related-card" onclick="openRelatedVideo(${r.id})">
        <img src="/thumb/${r.id}" alt="${escapeHtml(r.filename)}" loading="lazy"
          onerror="handleThumbError(this,${r.id})">
        <div class="related-info">
          <div class="related-name" title="${escapeHtml(r.filename)}">${escapeHtml(r.filename)}</div>
          <div class="related-meta">${r.duration ? formatDuration(r.duration) : ''} · ${formatSize(r.size)}</div>
        </div>
      </div>
    `).join('');
  } catch(e) { el.classList.add('hidden'); }
}

function showSeekIndicator(text) {
  const el = $('vpSeekIndicator');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 600);
}

// ── Player events ──────────────────────────────────────────────

const _vp = () => $('videoPlayer');

// Time update → progress + time display
document.addEventListener('DOMContentLoaded', () => {
  const player = _vp();
  if (!player) return;

  player.addEventListener('timeupdate', () => {
    if (!player.duration) return;
    const pct = (player.currentTime / player.duration) * 100;
    $('vpPlayed').style.width = pct + '%';
    $('vpTime').textContent = `${formatDuration(player.currentTime)} / ${formatDuration(player.duration)}`;
  });

  player.addEventListener('progress', () => {
    if (!player.duration || !player.buffered.length) return;
    const buffEnd = player.buffered.end(player.buffered.length - 1);
    $('vpBuffered').style.width = (buffEnd / player.duration * 100) + '%';
  });

  player.addEventListener('play', () => {
    $('vpPlayPause').textContent = '⏸';
    $('vpOverlay').classList.remove('paused');
    showPlayerUI();
  });
  player.addEventListener('pause', () => {
    $('vpPlayPause').textContent = '▶';
    $('vpOverlay').classList.add('paused');
    const modal = $q('.video-modal');
    if (modal) modal.classList.add('vp-show-ui');
    clearTimeout(uiHideTimer);
  });
  player.addEventListener('ended', () => {
    $('vpOverlay').classList.add('paused');
    $('vpPlayPause').textContent = '▶';
    // Auto-next
    if (state.videoIndex < state.videos.length - 1) {
      setTimeout(() => openVideo(state.videoIndex + 1), 1200);
    }
  });
  player.addEventListener('volumechange', () => {
    $('vpVolume').value = player.muted ? 0 : player.volume;
    $('vpMute').textContent = player.muted || player.volume === 0 ? '🔇' : player.volume < 0.5 ? '🔉' : '🔊';
  });
});

// ── Control buttons ────────────────────────────────────────────

$('closeVideo').addEventListener('click', closeVideoModal);
$('videoModal').addEventListener('click', e => { if (e.target === $('videoModal')) closeVideoModal(); });
$('videoPrev').addEventListener('click', () => {
  if (state.videoIndex > 0) {
    const prevId = state.videos[state.videoIndex - 1]?.id;
    if (prevId) openVideoById(prevId);
  }
});
$('videoNext').addEventListener('click', () => {
  if (state.videoIndex < state.videos.length - 1) {
    const nextId = state.videos[state.videoIndex + 1]?.id;
    if (nextId) openVideoById(nextId);
  }
});

// Play/Pause
$('vpPlayPause').addEventListener('click', () => {
  const p = _vp();
  p.paused ? p.play().catch(() => {}) : p.pause();
});
$('vpOverlay').addEventListener('click', e => {
  if (e.target.closest('.vp-big-play') || e.target === $('vpOverlay')) {
    const p = _vp();
    p.paused ? p.play().catch(() => {}) : p.pause();
  }
});

// Double-click to fullscreen
$('vpContainer').addEventListener('dblclick', e => {
  if (e.target.closest('.vp-controls')) return;
  toggleFullscreen();
});

// Skip
$('vpSkipBack').addEventListener('click', () => { const p = _vp(); p.currentTime = Math.max(0, p.currentTime - 10); showSeekIndicator('⏪ -10s'); });
$('vpSkipForward').addEventListener('click', () => { const p = _vp(); p.currentTime = Math.min(p.duration || 0, p.currentTime + 10); showSeekIndicator('⏩ +10s'); });

// Volume
$('vpMute').addEventListener('click', () => { const p = _vp(); p.muted = !p.muted; });
$('vpVolume').addEventListener('input', e => { const p = _vp(); p.volume = Number(e.target.value); p.muted = false; });

// Speed
$('vpSpeed').addEventListener('change', e => { _vp().playbackRate = Number(e.target.value); });

// PiP
$('vpPiP').addEventListener('click', async () => {
  const p = _vp();
  try {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); }
    else { await p.requestPictureInPicture(); }
  } catch(e) {}
});

// Fullscreen
function toggleFullscreen() {
  const modal = $q('.video-modal');
  if (!modal) return;
  if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }
  else { modal.requestFullscreen().catch(() => {}); }
}
$('vpFullscreen').addEventListener('click', toggleFullscreen);

// Progress bar seek
$('vpProgressWrap').addEventListener('click', e => {
  const p = _vp();
  if (!p.duration) return;
  const rect = $('vpProgressWrap').getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  p.currentTime = pct * p.duration;
});

// Progress bar hover tooltip
$('vpProgressWrap').addEventListener('mousemove', e => {
  const p = _vp();
  if (!p.duration) return;
  const rect = $('vpProgressWrap').getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const time = pct * p.duration;
  $('vpProgressTooltip').textContent = formatDuration(time);
  $('vpProgressHover').style.left = (pct * 100) + '%';
});

// Auto-hide UI on mouse move
$('vpContainer').addEventListener('mousemove', showPlayerUI);
$('vpContainer').addEventListener('mouseleave', () => {
  const p = _vp();
  if (p && !p.paused) {
    clearTimeout(uiHideTimer);
    uiHideTimer = setTimeout(() => $q('.video-modal')?.classList.remove('vp-show-ui'), 1500);
  }
});

// Favorite current video
$('favCurrentVideo').addEventListener('click', async () => {
  const id = $('favCurrentVideo').dataset.id;
  if (!id) return;
  try {
    const res = await apiPost(`${API}/media/${id}/favorite`);
    const btn = $('favCurrentVideo');
    btn.textContent = res.favorite ? '❤️' : '♡';
    btn.classList.toggle('active', !!res.favorite);
    const v = state.videos[state.videoIndex];
    if (v) v.favorite = res.favorite;
    showToast(res.favorite ? 'Ajoutée aux favoris ❤️' : 'Retirée des favoris');
  } catch(e) { showToast('Erreur', 'error'); }
});

/* ══════════════════════════════════════════════════════════════════
   PHOTO LIGHTBOX
   ══════════════════════════════════════════════════════════════════ */

function openPhoto(idx) {
  state.lightboxIndex = idx;
  const ph = state.photos[idx];
  if (!ph) return;
  $('lightboxImg').src = `/photo/${ph.id}`;
  $('lightboxTitle').textContent = ph.filename;
  $('lightboxCounter').textContent = `${idx + 1} / ${state.photos.length}`;

  // Set download link
  const dlPhoto = $('dlCurrentPhoto');
  if (dlPhoto) { dlPhoto.href = `/download/${ph.id}`; dlPhoto.setAttribute('download', ph.filename || ''); }

  const favBtn = $('favCurrentPhoto');
  favBtn.textContent = ph.favorite ? '❤️' : '♡';
  favBtn.classList.toggle('active', !!ph.favorite);
  favBtn.dataset.id = ph.id;

  $('photoModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Preload adjacent photos for smooth navigation
  if (state.photos[idx + 1]) new Image().src = `/photo/${state.photos[idx + 1].id}`;
  if (state.photos[idx - 1]) new Image().src = `/photo/${state.photos[idx - 1].id}`;

  // Track view
  apiPost(`${API}/media/${ph.id}/view`).catch(() => {});
}

function closePhotoModal() {
  $('photoModal').classList.add('hidden');
  document.body.style.overflow = '';
}

$('closePhoto').addEventListener('click', closePhotoModal);
$('photoModal').addEventListener('click', e => { if (e.target === $('photoModal')) closePhotoModal(); });
$('photoPrev').addEventListener('click', () => { if (state.lightboxIndex > 0) openPhoto(state.lightboxIndex - 1); });
$('photoNext').addEventListener('click', () => { if (state.lightboxIndex < state.photos.length - 1) openPhoto(state.lightboxIndex + 1); });

// Favorite current photo
$('favCurrentPhoto').addEventListener('click', async () => {
  const id = $('favCurrentPhoto').dataset.id;
  if (!id) return;
  try {
    const res = await apiPost(`${API}/media/${id}/favorite`);
    const btn = $('favCurrentPhoto');
    btn.textContent = res.favorite ? '❤️' : '♡';
    btn.classList.toggle('active', !!res.favorite);
    const ph = state.photos[state.lightboxIndex];
    if (ph) ph.favorite = res.favorite;
    showToast(res.favorite ? 'Ajoutée aux favoris ❤️' : 'Retirée des favoris');
  } catch(e) { showToast('Erreur', 'error'); }
});

/* ══════════════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ══════════════════════════════════════════════════════════════════ */

document.addEventListener('keydown', e => {
  // Video modal
  if (!$('videoModal').classList.contains('hidden')) {
    const p = _vp();
    switch(e.key) {
      case 'Escape': closeVideoModal(); break;
      case ' ':
        e.preventDefault();
        p.paused ? p.play().catch(() => {}) : p.pause();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) { $('videoPrev').click(); }
        else { p.currentTime = Math.max(0, p.currentTime - (e.ctrlKey ? 30 : 10)); showSeekIndicator(e.ctrlKey ? '⏪ -30s' : '⏪ -10s'); }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) { $('videoNext').click(); }
        else { p.currentTime = Math.min(p.duration || 0, p.currentTime + (e.ctrlKey ? 30 : 10)); showSeekIndicator(e.ctrlKey ? '⏩ +30s' : '⏩ +10s'); }
        break;
      case 'ArrowUp':
        e.preventDefault();
        p.volume = Math.min(1, p.volume + 0.1);
        p.muted = false;
        showSeekIndicator(`🔊 ${Math.round(p.volume * 100)}%`);
        break;
      case 'ArrowDown':
        e.preventDefault();
        p.volume = Math.max(0, p.volume - 0.1);
        showSeekIndicator(`🔉 ${Math.round(p.volume * 100)}%`);
        break;
      case 'm': case 'M':
        p.muted = !p.muted;
        showSeekIndicator(p.muted ? '🔇 Muet' : '🔊 Son');
        break;
      case 'f': case 'F':
        if (e.ctrlKey || e.metaKey) break; // don't hijack Cmd/Ctrl+F
        $('favCurrentVideo').click();
        break;
      case 'Enter':
        e.preventDefault();
        toggleFullscreen();
        break;
      case 'p': case 'P':
        $('vpPiP').click();
        break;
      case 'd': case 'D': {
        const dl = $('vpDownload');
        if (dl && dl.href) { const a = document.createElement('a'); a.href = dl.href; a.download = dl.download || ''; a.click(); }
        break;
      }
      case ',':
        e.preventDefault();
        if (p.paused) p.currentTime = Math.max(0, p.currentTime - 1/30);
        break;
      case '.':
        e.preventDefault();
        if (p.paused) p.currentTime = Math.min(p.duration || 0, p.currentTime + 1/30);
        break;
    }
    // Number keys: seek to %
    if (e.key >= '0' && e.key <= '9' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const pct = Number(e.key) / 10;
      p.currentTime = pct * (p.duration || 0);
      showSeekIndicator(`${e.key}0%`);
    }
    showPlayerUI();
    return;
  }
  // Photo lightbox
  if (!$('photoModal').classList.contains('hidden')) {
    if (e.key === 'Escape') closePhotoModal();
    if (e.key === 'ArrowLeft') $('photoPrev').click();
    if (e.key === 'ArrowRight') $('photoNext').click();
    if (e.key === 'f' || e.key === 'F') $('favCurrentPhoto').click();
    return;
  }
  // Modals
  if (e.key === 'Escape') {
    $('manageModal').classList.add('hidden');
    $('statsModal').classList.add('hidden');
    document.body.style.overflow = '';
  }
  // Search shortcut
  if ((e.key === '/' || (e.ctrlKey && e.key === 'k')) && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    $('searchInput').focus();
  }
});

/* ══════════════════════════════════════════════════════════════════
   MANAGE MODAL
   ══════════════════════════════════════════════════════════════════ */

$('btnManage').addEventListener('click', async () => {
  if (!auth.user || auth.user.role !== 'admin') {
    showToast('Accès réservé aux administrateurs', 'error');
    openAuthModal('loginForm');
    return;
  }
  try {
    const stats = await apiFetch(`${API}/stats`);
    $('mediaDir').textContent = stats.mediaDir || 'Non configuré';
  } catch(e) {
    $('mediaDir').textContent = 'Voir .env (MEDIA_DIR)';
  }
  $('manageModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
});

$('closeManage').addEventListener('click', () => {
  $('manageModal').classList.add('hidden');
  document.body.style.overflow = '';
  if (state.scanInterval) { clearInterval(state.scanInterval); state.scanInterval = null; }
});

$('manageModal').addEventListener('click', e => {
  if (e.target === $('manageModal')) {
    $('manageModal').classList.add('hidden');
    document.body.style.overflow = '';
    if (state.scanInterval) { clearInterval(state.scanInterval); state.scanInterval = null; }
  }
});

/* ── Scan progress tracking (persistent across refresh) ────────── */

const MODE_LABELS = { all: '📡 Tout', photos: '🖼 Photos', videos: '🎬 Vidéos' };

function updateScanUI(p) {
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  const modeLabel = MODE_LABELS[p.mode] || '📡';
  const text = p.total > 0
    ? `${modeLabel} — ${p.done} / ${p.total} fichiers (${pct}%)${p.errors > 0 ? ` — ${p.errors} erreur(s)` : ''}`
    : `${modeLabel} — ${p.done} fichiers indexés…`;

  // Modal progress
  $('progressFill').style.width = pct + '%';
  $('progressText').textContent = text;

  // Top banner
  $('scanBannerFill').style.width = pct + '%';
  $('scanBannerText').textContent = text;
}

function showScanRunning() {
  $('btnScanAll').disabled = true;
  $('btnScanPhotos').disabled = true;
  $('btnScanVideos').disabled = true;
  $('btnCancelScan').style.display = '';
  $('scanProgress').classList.remove('hidden');
  $('scanBanner').classList.remove('hidden');
}

function hideScanRunning() {
  $('btnScanAll').disabled = false;
  $('btnScanPhotos').disabled = false;
  $('btnScanVideos').disabled = false;
  $('btnCancelScan').style.display = 'none';
  $('btnCancelScan').disabled = false;
  $('scanBanner').classList.add('hidden');
}

function startScanPolling() {
  if (state.scanInterval) return; // already polling
  showScanRunning();

  state.scanInterval = setInterval(async () => {
    try {
      const p = await apiFetch(`${API}/scan/progress`);
      updateScanUI(p);

      if (!p.running) {
        clearInterval(state.scanInterval);
        state.scanInterval = null;
        hideScanRunning();
        const modeLabel = MODE_LABELS[p.mode] || '';

        if (p.cancelled) {
          const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
          $('progressFill').style.width = pct + '%';
          $('progressText').textContent = `⛔ ${modeLabel} — Annulé — ${p.done} / ${p.total} fichiers indexés${p.errors ? ` (${p.errors} erreurs)` : ''}`;
          showToast(`Scan annulé — ${p.done} fichiers indexés`, 'error');
        } else {
          $('progressFill').style.width = '100%';
          $('progressText').textContent = `✅ ${modeLabel} — Terminé — ${p.done} fichiers indexés${p.errors ? ` (${p.errors} erreurs)` : ''}`;
          showToast(`Scan terminé — ${p.done} fichiers`, 'success');
        }
        loadPerformers(getSortParams());
        loadHeroStats();
      }
    } catch(e) {
      clearInterval(state.scanInterval);
      state.scanInterval = null;
      hideScanRunning();
      showToast('Erreur lors du suivi du scan', 'error');
    }
  }, 800);
}

// Check on page load if a scan is already running
async function checkScanOnLoad() {
  try {
    const p = await apiFetch(`${API}/scan/progress`);
    if (p.running) {
      startScanPolling();
    }
  } catch(e) { /* ignore */ }
}

async function launchScan(mode) {
  try {
    await apiPost(`${API}/scan?mode=${mode}`);
    showToast(`Scan ${MODE_LABELS[mode]} lancé !`);
    startScanPolling();
  } catch(e) {
    showToast('Erreur: ' + e.message, 'error');
  }
}

$('btnScanAll').addEventListener('click', () => launchScan('all'));
$('btnScanPhotos').addEventListener('click', () => launchScan('photos'));
$('btnScanVideos').addEventListener('click', () => launchScan('videos'));

$('btnCancelScan').addEventListener('click', async () => {
  try {
    $('btnCancelScan').disabled = true;
    await apiPost(`${API}/scan/cancel`);
    showToast('Annulation en cours…');
  } catch(e) {
    showToast('Erreur: ' + e.message, 'error');
    $('btnCancelScan').disabled = false;
  }
});

$('scanBannerCancel').addEventListener('click', async () => {
  try {
    $('scanBannerCancel').disabled = true;
    await apiPost(`${API}/scan/cancel`);
    showToast('Annulation en cours…');
  } catch(e) {
    showToast('Erreur: ' + e.message, 'error');
    $('scanBannerCancel').disabled = false;
  }
});

$('btnClear').addEventListener('click', async () => {
  if (!confirm('Vider la base de données ? Toutes les entrées seront supprimées (pas les fichiers).')) return;
  try {
    await apiPost(`${API}/clear`);
    showToast('Base de données vidée.', 'success');
    loadPerformers({});
    loadHeroStats();
  } catch(e) {
    showToast('Erreur: ' + e.message, 'error');
  }
});

/* ══════════════════════════════════════════════════════════════════
   STATS MODAL
   ══════════════════════════════════════════════════════════════════ */

$('btnStats').addEventListener('click', async () => {
  $('statsModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  $('statsGrid').innerHTML = '<div class="loading-spinner" style="padding:20px 0;grid-column:1/-1"><div class="spinner"></div></div>';

  try {
    const s = await apiFetch(`${API}/stats`);
    const cards = [
      { value: s.performers, label: 'Performeuses', icon: '🎭', color: '#e50914' },
      { value: s.videos,     label: 'Vidéos',       icon: '🎬', color: '#a855f7' },
      { value: s.photos,     label: 'Photos',       icon: '🖼️', color: '#3b82f6' },
      { value: formatSize(s.totalSize), label: 'Taille totale', icon: '💾', color: '#22c55e' },
      { value: s.favorites,  label: 'Favoris',      icon: '❤️', color: '#ff4d8d' },
      { value: s.totalViews, label: 'Vues totales',  icon: '👁', color: '#06b6d4' },
      { value: s.favPerformers, label: 'Perf. favorites', icon: '⭐', color: '#f5c518' },
      { value: s.totalDuration ? formatDuration(s.totalDuration) : '0', label: 'Durée totale', icon: '⏱', color: '#a855f7' },
    ];
    $('statsGrid').innerHTML = cards.map(c => `
      <div class="stat-card">
        <span class="stat-value" style="color:${c.color}">${c.icon} ${c.value}</span>
        <span class="stat-label">${c.label}</span>
      </div>
    `).join('');
  } catch(e) {
    $('statsGrid').innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:20px;grid-column:1/-1">Aucune donnée — lancez un scan d'abord.</p>`;
  }
});

function var_(name, fallback) { return fallback; }

$('closeStats').addEventListener('click', () => {
  $('statsModal').classList.add('hidden');
  document.body.style.overflow = '';
});
$('statsModal').addEventListener('click', e => {
  if (e.target === $('statsModal')) { $('statsModal').classList.add('hidden'); document.body.style.overflow = ''; }
});

/* ══════════════════════════════════════════════════════════════════
   AUTH MODULE
   ══════════════════════════════════════════════════════════════════ */
const auth = {
  user: null,
  token: () => localStorage.getItem('xflix_token'),
  setToken: (t) => localStorage.setItem('xflix_token', t),
  clearToken: () => localStorage.removeItem('xflix_token'),
};

function authHeaders() {
  const t = auth.token();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function authInit() {
  // 1. Check server config (registration open?)
  try {
    const cfg = await fetch('/auth/config').then(r => r.json());
    if (!cfg.allow_registration) {
      $('tabRegister').style.display = 'none';
    } else {
      $('tabRegister').style.display = '';
    }
  } catch {}

  // 2. Check for password reset token in URL (/reset-password?token=xxx)
  const urlParams = new URLSearchParams(window.location.search);
  const resetTok = urlParams.get('token');
  if (resetTok) {
    $('resetToken').value = resetTok;
    window.history.replaceState({}, '', window.location.pathname);
    openAuthModal('resetForm');
  }

  // 3. Restore session
  if (!auth.token()) { updateAuthUI(null); return; }
  try {
    const r = await fetch('/auth/me', { headers: { Authorization: `Bearer ${auth.token()}` } });
    if (!r.ok) { auth.clearToken(); updateAuthUI(null); return; }
    auth.user = await r.json();
    updateAuthUI(auth.user);
  } catch { updateAuthUI(null); }
}

function updateAuthUI(user) {
  const authArea = $('authArea');
  const userMenu = $('userMenu');
  const isAdmin = user && user.role === 'admin';
  // Manage button (gear icon) — admins only
  $('btnManage').classList.toggle('hidden', !isAdmin);
  $('heroManage').classList.toggle('hidden', !isAdmin);
  if (!user) {
    authArea.classList.remove('hidden');
    userMenu.classList.add('hidden');
    if ($('favTabMy')) $('favTabMy').classList.add('hidden');
    return;
  }
  authArea.classList.add('hidden');
  userMenu.classList.remove('hidden');
  $('userUname').textContent = user.username;
  $('userAvatar').textContent = (user.username || '?').charAt(0).toUpperCase();
  // Show admin link
  $('ddAdmin').classList.toggle('hidden', !isAdmin);
  // Show personal favorites tab
  if ($('favTabMy')) $('favTabMy').classList.remove('hidden');
}

// Auth modal
const authModal = $('authModal');
function openAuthModal(form) {
  authModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  ['loginForm','registerForm','forgotForm','resetForm'].forEach(id => { const el = $(id); if(el) el.classList.add('hidden'); });
  const target = $(form);
  if (target) target.classList.remove('hidden');
  // Tab highlight
  ['tabLogin','tabRegister'].forEach(id => { const el = $(id); if(el) el.classList.remove('active'); });
  if (form === 'loginForm')    { const el = $('tabLogin');    if(el) el.classList.add('active'); }
  if (form === 'registerForm') { const el = $('tabRegister'); if(el) el.classList.add('active'); }
  // Hide tabs for utility forms (forgot, reset)
  const hideTabs = form === 'forgotForm' || form === 'resetForm';
  const tabsEl = authModal.querySelector('.auth-tabs');
  if (tabsEl) tabsEl.style.display = hideTabs ? 'none' : '';
}
// Buttons
$('btnLogin').addEventListener('click', () => openAuthModal('loginForm'));
const closeAuthEl = $('closeAuth');
if (closeAuthEl) closeAuthEl.addEventListener('click', () => { authModal.classList.add('hidden'); document.body.style.overflow = ''; });
authModal.addEventListener('click', e => { if (e.target === authModal) { authModal.classList.add('hidden'); document.body.style.overflow = ''; } });

$('tabLogin').addEventListener('click', () => openAuthModal('loginForm'));
$('tabRegister').addEventListener('click', () => openAuthModal('registerForm'));
$('forgotPwLink').addEventListener('click', e => { e.preventDefault(); openAuthModal('forgotForm'); });
$('backToLogin').addEventListener('click', e => { e.preventDefault(); openAuthModal('loginForm'); });

// Login form
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('loginError');
  err.classList.add('hidden');
  try {
    const r = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('loginEmail').value, password: $('loginPassword').value }),
    });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error; err.classList.remove('hidden'); return; }
    auth.setToken(d.token);
    auth.user = d.user;
    updateAuthUI(d.user);
    authModal.classList.add('hidden');
    document.body.style.overflow = '';
    showToast('Bienvenue, ' + d.user.username + ' !', 'success');
  } catch { err.textContent = 'Erreur de connexion'; err.classList.remove('hidden'); }
});

// Register form
$('registerForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('registerError');
  err.classList.add('hidden');
  try {
    const r = await fetch('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('regUsername').value, email: $('regEmail').value, password: $('regPassword').value }),
    });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error; err.classList.remove('hidden'); return; }
    auth.setToken(d.token);
    auth.user = d.user;
    updateAuthUI(d.user);
    authModal.classList.add('hidden');
    document.body.style.overflow = '';
    showToast('Compte cree ! Bienvenue, ' + d.user.username + ' !', 'success');
  } catch(ex) { err.textContent = ex.message || 'Erreur inscription'; err.classList.remove('hidden'); }
});

// Forgot password form
$('forgotForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('forgotError');
  err.classList.add('hidden');
  try {
    const r = await fetch('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('forgotEmail').value }),
    });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error; err.classList.remove('hidden'); return; }
    err.style.color = '#a8e8c8';
    err.textContent = d.message || 'Lien envoye ! Verifiez votre boite mail.';
    // Show clickable link if SMTP not configured (dev mode)
    if (d.resetUrl) {
      const a = document.createElement('a');
      a.href = d.resetUrl;
      a.style.cssText = 'display:block;margin-top:8px;color:#6cf;word-break:break-all;font-size:12px';
      a.textContent = d.resetUrl;
      err.appendChild(a);
    }
    err.classList.remove('hidden');
  } catch { err.textContent = 'Erreur'; err.classList.remove('hidden'); }
});

// Reset password form (via token URL)
const resetFormEl = $('resetForm');
if (resetFormEl) {
  resetFormEl.addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('resetError');
    err.classList.add('hidden');
    const pw  = $('resetPassword').value;
    const pw2 = $('resetPasswordConfirm').value;
    if (pw !== pw2) { err.textContent = 'Les mots de passe ne correspondent pas'; err.classList.remove('hidden'); return; }
    try {
      const r = await fetch('/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: $('resetToken').value, newPassword: pw }),
      });
      const d = await r.json();
      if (!r.ok) { err.textContent = d.error; err.classList.remove('hidden'); return; }
      authModal.classList.add('hidden');
      document.body.style.overflow = '';
      showToast('Mot de passe mis a jour ! Vous pouvez vous connecter.', 'success');
      setTimeout(() => openAuthModal('loginForm'), 500);
    } catch { err.textContent = 'Erreur'; err.classList.remove('hidden'); }
  });
}

/* ── User menu dropdown ─────────────────────────────────────────── */
$('userMenuToggle').addEventListener('click', () => $('userDropdown').classList.toggle('hidden'));
document.addEventListener('click', e => { if (!e.target.closest('#userMenu')) $('userDropdown').classList.add('hidden'); });

$('ddLogout').addEventListener('click', () => {
  auth.clearToken(); auth.user = null;
  updateAuthUI(null);
  $('userDropdown').classList.add('hidden');
  showToast('Deconnecte', '');
});

$('ddFavorites').addEventListener('click', e => {
  e.preventDefault();
  $('userDropdown').classList.add('hidden');
  document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
  $('navFavorites').classList.add('active');
  showFavoritesPage();
});

$('ddProfile').addEventListener('click', () => {
  $('userDropdown').classList.add('hidden');
  openProfileModal();
});

/* ── Helper: show favorites page ────────────────────────────────── */
function showFavoritesPage() {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $('favoritesPage').classList.add('active');
  window.scrollTo(0, 0);
  state.currentPage = 'favorites';
}

/* ── Profile Modal ──────────────────────────────────────────────── */
const profileModal = $('profileModal');

function openProfileModal() {
  if (!auth.user) { openAuthModal('loginForm'); return; }
  $('profileUsername').value = auth.user.username || '';
  $('profileBio').value = auth.user.bio || '';
  $('profileEmailSmall').textContent = auth.user.email || '';
  $('profileAvatarBig').textContent = (auth.user.username || '?').charAt(0).toUpperCase();
  const badge = $('profileRoleBadge');
  badge.textContent = auth.user.role === 'admin' ? 'Administrateur' : 'Membre';
  badge.className = 'profile-role-badge badge-' + auth.user.role;
  $('profileCurrentPw').value = '';
  $('profileNewPw').value = '';
  $('profileNewPwConfirm').value = '';
  $('profileError').classList.add('hidden');
  $('profilePwError').classList.add('hidden');

  fetch('/auth/me', { headers: authHeaders() }).then(r => r.json()).then(u => {
    $('profileBio').value = u.bio || '';
    $('profileCreatedAt').textContent = u.created_at ? new Date(u.created_at).toLocaleDateString('fr-FR') : '-';
    $('profileLastLogin').textContent = u.last_login ? new Date(u.last_login).toLocaleDateString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '-';
  }).catch(() => {});

  profileModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

$('closeProfile').addEventListener('click', () => { profileModal.classList.add('hidden'); document.body.style.overflow = ''; });
profileModal.addEventListener('click', e => { if (e.target === profileModal) { profileModal.classList.add('hidden'); document.body.style.overflow = ''; } });

$('saveProfileBtn').addEventListener('click', async () => {
  const err = $('profileError');
  err.classList.add('hidden');
  const username = $('profileUsername').value.trim();
  const bio = $('profileBio').value.trim();
  if (!username) { err.textContent = 'Le nom utilisateur est requis'; err.classList.remove('hidden'); return; }
  try {
    const r = await fetch('/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ username, bio }),
    });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error; err.classList.remove('hidden'); return; }
    auth.user = { ...auth.user, ...d };
    updateAuthUI(auth.user);
    showToast('Profil mis a jour', 'success');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
});

$('changePwBtn').addEventListener('click', async () => {
  const err = $('profilePwError');
  err.classList.add('hidden');
  const cur = $('profileCurrentPw').value;
  const nw = $('profileNewPw').value;
  const nwc = $('profileNewPwConfirm').value;
  if (!cur || !nw) { err.textContent = 'Remplissez tous les champs'; err.classList.remove('hidden'); return; }
  if (nw !== nwc) { err.textContent = 'Les mots de passe ne correspondent pas'; err.classList.remove('hidden'); return; }
  if (nw.length < 6) { err.textContent = 'Minimum 6 caracteres'; err.classList.remove('hidden'); return; }
  try {
    const r = await fetch('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ currentPassword: cur, newPassword: nw }),
    });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error; err.classList.remove('hidden'); return; }
    $('profileCurrentPw').value = '';
    $('profileNewPw').value = '';
    $('profileNewPwConfirm').value = '';
    showToast('Mot de passe change', 'success');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
});

/* ── Personal Favorites Tab ─────────────────────────────────────── */
async function loadMyFavorites() {
  const el = $('myFavContent');
  el.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Chargement...</p></div>';
  el.classList.remove('hidden');
  $('favContent').classList.add('hidden');

  try {
    const r = await fetch('/social/favorites?limit=100', { headers: authHeaders() });
    const { data } = await r.json();
    if (!data || !data.length) {
      el.innerHTML = '<div class="empty-state"><p>Aucun favori personnel pour l\'instant.<br>Aimez une video pour la retrouver ici.</p></div>';
      return;
    }
    const videos = data.filter(m => m.type === 'video');
    const photos = data.filter(m => m.type === 'photo');
    let html = '';
    if (videos.length) {
      html += '<h3 class="subsection-title">Videos (' + videos.length + ')</h3>';
      html += '<div class="media-grid videos-grid">' + videos.map(v =>
        '<div class="media-card video-card" onclick="openVideoById(' + v.id + ')">' +
        '<div class="media-thumb-wrap"><img src="/thumb/' + v.id + '" loading="lazy" onerror="handleThumbError(this,' + v.id + ')"></div>' +
        '<div class="media-info"><span class="media-name">' + escapeHtml(v.filename) + '</span>' +
        (v.performer_name ? '<span class="media-meta">' + escapeHtml(v.performer_name) + '</span>' : '') +
        '</div></div>'
      ).join('') + '</div>';
    }
    if (photos.length) {
      html += '<h3 class="subsection-title" style="margin-top:24px">Photos (' + photos.length + ')</h3>';
      html += '<div class="media-grid photos-grid">' + photos.map(p =>
        '<div class="media-card photo-card" onclick="openPhotoById(' + p.id + ')">' +
        '<div class="media-thumb-wrap"><img src="/thumb/' + p.id + '" loading="lazy"></div>' +
        '<div class="media-info"><span class="media-name">' + escapeHtml(p.filename) + '</span></div>' +
        '</div>'
      ).join('') + '</div>';
    }
    el.innerHTML = html;
  } catch(ex) {
    el.innerHTML = '<div class="empty-state"><p>Erreur : ' + escapeHtml(ex.message) + '</p></div>';
  }
}

window.openVideoById = async function(id) {
  const idx = state.videos.findIndex(v => v.id === id);
  if (idx >= 0) { openVideo(idx); return; }
  try {
    const info = await apiFetch('/api/media/' + id);
    state.videos = [info]; openVideo(0);
  } catch {}
};

window.openPhotoById = function(id) {
  const idx = state.photos.findIndex(p => p.id === id);
  if (idx >= 0) openPhoto(idx);
};

// Wire personal favorites tab
document.querySelectorAll('[data-ftab]').forEach(btn => {
  if (btn.dataset.ftab === 'fav-my') {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-ftab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (auth.user) loadMyFavorites();
      else {
        $('myFavContent').innerHTML = '<div class="empty-state"><p>Connectez-vous pour voir vos favoris personnels.</p></div>';
        $('myFavContent').classList.remove('hidden');
        $('favContent').classList.add('hidden');
      }
    });
  } else {
    btn.addEventListener('click', () => {
      if ($('myFavContent')) $('myFavContent').classList.add('hidden');
      if ($('favContent')) $('favContent').classList.remove('hidden');
    });
  }
});

/* ══════════════════════════════════════════════════════════════════
   REACTIONS (like/dislike)
   ══════════════════════════════════════════════════════════════════ */
let currentReactionMediaId = null;

async function loadReactions(mediaId) {
  currentReactionMediaId = mediaId;
  const likeBtn = $('vpLikeBtn');
  const dislikeBtn = $('vpDislikeBtn');
  likeBtn.classList.remove('active-reaction');
  dislikeBtn.classList.remove('active-reaction');
  try {
    const r = await fetch(`/social/reactions/${mediaId}`, { headers: authHeaders() });
    const d = await r.json();
    $('vpLikeCount').textContent = d.likes;
    $('vpDislikeCount').textContent = d.dislikes;
    if (d.userReaction === 'like') likeBtn.classList.add('active-reaction');
    if (d.userReaction === 'dislike') dislikeBtn.classList.add('active-reaction');
  } catch {}
}

async function sendReaction(type) {
  if (!auth.user) { openAuthModal('loginForm'); return; }
  if (!currentReactionMediaId) return;
  try {
    const r = await fetch(`/social/reactions/${currentReactionMediaId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ type }),
    });
    const d = await r.json();
    $('vpLikeCount').textContent = d.likes;
    $('vpDislikeCount').textContent = d.dislikes;
    $('vpLikeBtn').classList.toggle('active-reaction', d.userReaction === 'like');
    $('vpDislikeBtn').classList.toggle('active-reaction', d.userReaction === 'dislike');
  } catch {}
}

$('vpLikeBtn').addEventListener('click', () => sendReaction('like'));
$('vpDislikeBtn').addEventListener('click', () => sendReaction('dislike'));

/* ══════════════════════════════════════════════════════════════════
   COMMENTS
   ══════════════════════════════════════════════════════════════════ */
let commentsMediaId = null;
let commentsPage = 1;
let commentsTotal = 0;
const COMMENTS_LIMIT = 10;

async function loadComments(mediaId, reset = true) {
  commentsMediaId = mediaId;
  if (reset) { commentsPage = 1; $('commentsList').innerHTML = ''; }

  $('commentForm').classList.toggle('hidden', !auth.user);

  const r = await fetch(`/social/comments/${mediaId}?page=${commentsPage}&limit=${COMMENTS_LIMIT}`, { headers: authHeaders() });
  const { data, total } = await r.json();
  commentsTotal = total;

  data.forEach(c => appendComment(c));

  const loadMore = $('loadMoreComments');
  loadMore.classList.toggle('hidden', commentsPage * COMMENTS_LIMIT >= total);
}

function appendComment(c) {
  const div = document.createElement('div');
  div.className = 'comment-item';
  div.id = `comment-${c.id}`;
  const canDelete = auth.user && (auth.user.id === c.user_id || auth.user.role === 'admin');
  div.innerHTML = `
    <div class="comment-avatar">${escapeHtml(c.username.charAt(0).toUpperCase())}</div>
    <div class="comment-body">
      <div class="comment-header">
        <span class="comment-author">${escapeHtml(c.username)}</span>
        ${c.role === 'admin' ? '<span class="comment-admin-badge">admin</span>' : ''}
        <span class="comment-date">${fmtCommentDate(c.created_at)}</span>
        ${canDelete ? `<button class="btn-comment-del" onclick="deleteComment(${c.id})">✕</button>` : ''}
      </div>
      <div class="comment-text">${escapeHtml(c.content)}</div>
    </div>
  `;
  $('commentsList').appendChild(div);
}

function fmtCommentDate(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'il y a quelques secondes';
  if (diff < 3600) return `il y a ${Math.floor(diff/60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff/3600)} h`;
  return d.toLocaleDateString('fr-FR');
}

window.deleteComment = async (id) => {
  if (!confirm('Supprimer ce commentaire ?')) return;
  const r = await fetch(`/social/comments/${id}`, { method: 'DELETE', headers: authHeaders() });
  if (r.ok) { const el = $(`comment-${id}`); if (el) el.remove(); }
};

$('commentsToggle').addEventListener('click', () => {
  const body = $('commentsBody');
  const open = body.classList.toggle('hidden');
  $('commentsToggle').textContent = open ? 'Afficher' : 'Masquer';
  if (!open && commentsMediaId) loadComments(commentsMediaId);
});

$('commentSubmit').addEventListener('click', async () => {
  if (!auth.user) { openAuthModal('loginForm'); return; }
  const txt = $('commentInput').value.trim();
  if (!txt) return;
  const r = await fetch(`/social/comments/${commentsMediaId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ content: txt }),
  });
  if (r.ok) {
    const c = await r.json();
    $('commentInput').value = '';
    // Prepend to list
    const tmp = document.createElement('div');
    tmp.className = 'comment-item new';
    tmp.id = `comment-${c.id}`;
    const canDelete = true;
    tmp.innerHTML = `
      <div class="comment-avatar">${escapeHtml(c.username.charAt(0).toUpperCase())}</div>
      <div class="comment-body">
        <div class="comment-header">
          <span class="comment-author">${escapeHtml(c.username)}</span>
          <span class="comment-date">il y a quelques secondes</span>
          <button class="btn-comment-del" onclick="deleteComment(${c.id})">✕</button>
        </div>
        <div class="comment-text">${escapeHtml(c.content)}</div>
      </div>
    `;
    $('commentsList').prepend(tmp);
  }
});

$('loadMoreComments').addEventListener('click', () => { commentsPage++; loadComments(commentsMediaId, false); });

/* ══════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════ */

window.openPerformer = openPerformer;
window.openVideo = openVideo;
window.openPhoto = openPhoto;
window.loadVideos = loadVideos;
window.loadPhotos = loadPhotos;
window.handleThumbError = handleThumbError;
window.renderSingleVideoCard = renderSingleVideoCard;

// Related video navigation (opens by media id)
function openRelatedVideo(id) { openVideoById(id); }
window.openRelatedVideo = openRelatedVideo;

/* ── Theme toggle ───────────────────────────────────────────── */
function initTheme() {
  const stored = localStorage.getItem('xflix_theme');
  if (stored === 'light') {
    document.documentElement.classList.add('light-theme');
    const btn = $('btnTheme');
    if (btn) btn.textContent = '☀️';
  }
}

if ($('btnTheme')) {
  $('btnTheme').addEventListener('click', () => {
    const isLight = document.documentElement.classList.toggle('light-theme');
    $('btnTheme').textContent = isLight ? '☀️' : '🌙';
    localStorage.setItem('xflix_theme', isLight ? 'light' : 'dark');
  });
}

/* ── Nouveautés page ────────────────────────────────────────── */
let currentNewTab = 'new-videos';

$qa('[data-ntab]').forEach(t => {
  t.addEventListener('click', () => {
    $qa('[data-ntab]').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    currentNewTab = t.dataset.ntab;
    loadNewPage();
  });
});

async function loadNewPage() {
  const grid = $('newPageGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Chargement…</p></div>';
  const type = currentNewTab === 'new-videos' ? 'video' : 'photo';
  try {
    const { data } = await apiFetch(`${API}/new?type=${type}&limit=80`);
    if (type === 'video') {
      state.videos = data;
      renderVideoCards(data, grid, true);
    } else {
      state.photos = data;
      renderPhotoCards(data, grid);
    }
  } catch(e) {
    grid.innerHTML = `<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;
  }
}

// Initial load
authInit();
initTheme();

// Restore sort preferences from previous session
(function restoreSortPrefs() {
  const sp = localStorage.getItem('xflix_sort_performers');
  const sv = localStorage.getItem('xflix_sort_videos');
  const sph = localStorage.getItem('xflix_sort_photos');
  if (sp && $('sortPerformers').querySelector(`option[value="${sp}"]`)) $('sortPerformers').value = sp;
  if (sv && $('sortVideos').querySelector(`option[value="${sv}"]`)) $('sortVideos').value = sv;
  if (sph && $('sortPhotos').querySelector(`option[value="${sph}"]`)) $('sortPhotos').value = sph;
})();

loadPerformers({});
loadHeroStats();
checkScanOnLoad();
// Pre-populate tag filter (lazy, non-blocking)
loadVideoTagFilter();
