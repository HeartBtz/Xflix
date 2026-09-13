/* ═══════════════════════════════════════════════════════════════
   XFlix — Frontend Application (Enhanced)
   ═══════════════════════════════════════════════════════════════ */

const API = '/api';
const Navigation = window.XflixNavigation;

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

// A response may update only the view and session that requested it.
const requests = new Map();
let baseEpoch = 0;
let sessionEpoch = 0;
let mediaEpoch = 0;
let globalFavoritesDirty = false;
function requestGuard(key, media = false) {
  const id = (requests.get(key) || 0) + 1;
  requests.set(key, id);
  const base = baseEpoch, session = sessionEpoch, playback = mediaEpoch;
  return () => requests.get(key) === id && base === baseEpoch && session === sessionEpoch
    && (!media || playback === mediaEpoch);
}

async function checkedFetch(url, options = {}) {
  const session = sessionEpoch;
  const response = await fetch(url, options);
  if (response.status === 401 && session === sessionEpoch) {
    resetUserState();
    updateAuthUI(null);
    openAuthModal('loginForm');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `API error ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

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
  const session = sessionEpoch;
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (session !== sessionEpoch) throw new Error('Session modifiée');
    try {
      const r = await checkedFetch(url);
      return await r.json();
    } catch(e) {
      if (attempt === retries) throw e;
      // Retry on network errors (Failed to fetch, NetworkError)
      if (e instanceof TypeError || e.status === 503) {
        await new Promise(res => setTimeout(res, delay * attempt));
      } else {
        throw e; // erreur applicative (4xx, 5xx) → pas de retry
      }
    }
  }
}

async function apiPost(url) {
  const r = await checkedFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  return r.json();
}

async function loadPersonalFavorite(mediaId, button) {
  const guard = requestGuard(button.id, true);
  if (!auth.user) return;
  try {
    const result = await apiFetch(`/social/favorites/${mediaId}`);
    if (!guard() || button.dataset.id !== String(mediaId)) return;
    button.textContent = result.favorited ? '❤️' : '♡';
    button.classList.toggle('active', Boolean(result.favorited));
  } catch (_) { if (guard()) { button.textContent = '?'; button.setAttribute('aria-label', 'Favori personnel indisponible, réessayer'); } }
}

function showToast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast hidden'; }, 3000);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

// Event delegation keeps dynamic cards CSP-compatible: no executable code is
// embedded in user-controlled HTML attributes.
document.addEventListener('click', event => {
  const deleteButton = event.target.closest('[data-comment-delete]');
  if (deleteButton) { window.deleteComment(Number(deleteButton.dataset.commentDelete)); return; }
  const performer = event.target.closest('[data-performer]');
  if (performer) { openPerformer(performer.dataset.performer); return; }
  const video = event.target.closest('[data-video-id]');
  if (video) { openVideoById(Number(video.dataset.videoId)); return; }
  const photoId = event.target.closest('[data-photo-id]');
  if (photoId) { openPhotoById(Number(photoId.dataset.photoId)); return; }
  const photoIndex = event.target.closest('[data-photo-index]');
  if (photoIndex) openPhoto(Number(photoIndex.dataset.photoIndex));
});

document.addEventListener('error', event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  if (image.hasAttribute('data-performer-thumb-error')) {
    image.style.display = 'none';
    if (image.nextElementSibling) image.nextElementSibling.style.display = 'flex';
    return;
  }
  if (image.dataset.photoFallback) {
    const id = image.dataset.photoFallback;
    delete image.dataset.photoFallback;
    image.src = `/photo/${id}`;
    return;
  }
  if (image.dataset.thumbId) handleThumbError(image, Number(image.dataset.thumbId));
}, true);

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
function showPage(id, { resetScroll = true } = {}) {
  $qa('.page').forEach(p => p.classList.remove('active'));
  $(id).classList.add('active');
  if (resetScroll) window.scrollTo(0, 0);

  // Update nav links
  const pageMap = { homePage: 'home', favoritesPage: 'favorites', discoverPage: 'discover', newPage: 'new', performerPage: null };
  $qa('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.page === pageMap[id]));
  updateMobileNav(pageMap[id]);
}

/* ══════════════════════════════════════════════════════════════════
   HOME PAGE
   ══════════════════════════════════════════════════════════════════ */

async function loadHeroStats() {
  const session = sessionEpoch;
  try {
    const s = await apiFetch(`${API}/stats`);
    if (session !== sessionEpoch) return;
    $('heroStats').innerHTML = [
      { v: s.performers, l: 'Performeuses' },
      { v: formatNumber(s.videos), l: 'Vidéos' },
      { v: formatNumber(s.photos), l: 'Photos' },
      { v: formatSize(s.totalSize), l: 'Total' },
    ].map(x => `<div class="hero-stat"><span class="hero-stat-value">${x.v}</span><span class="hero-stat-label">${x.l}</span></div>`).join('');
  } catch(e) {}
}

async function loadPerformers(params = {}, page = 1) {
  const guard = requestGuard('performers');
  const grid = $('performersGrid');
  grid.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Chargement…</p></div>';

  const [sort, order = 'asc'] = (params.sort || 'name').split('|');
  const qs = new URLSearchParams({
    sort, order, limit: 60, offset: (page - 1) * 60,
    ...(params.q          ? { q: params.q }                : {}),
    ...(params.minVideos  ? { minVideos: params.minVideos } : {}),
    ...(params.minPhotos  ? { minPhotos: params.minPhotos } : {}),
    ...(params.favorite   ? { favorite: '1' }              : {}),
  });

  try {
    const { data, total } = await apiFetch(`${API}/performers?${qs}`);
    if (!guard()) return;
    state.performers = data;
    $('performerCount').textContent = `${total} performeuse${total > 1 ? 's' : ''}`;
    $('sectionTitle').textContent = params.q ? `Résultats pour « ${params.q} »` : (params.favorite ? '⭐ Performeuses favorites' : 'Toutes les performeuses');
    renderPerformers(data);
    renderPagination('performersPagination', page, Math.ceil(total / 60), p => loadPerformers(params, p));
  } catch(e) {
    if (!guard()) return;
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
    const initials = escapeHtml(p.name.slice(0, 2).toUpperCase());
    // Use random_cover_id for variety on each page load, fallback to cover_media_id
    const thumbSrc = (p.random_cover_id || p.cover_media_id) ? `/thumb/${p.random_cover_id || p.cover_media_id}` : '';
    return `
      <div class="performer-card" data-name="${escapeHtml(p.name)}" data-performer="${escapeHtml(encodeURIComponent(p.name))}">
        <div class="performer-thumb-wrap">
          ${thumbSrc
            ? `<img class="performer-thumb" data-src="${thumbSrc}" data-performer-thumb-error alt="${escapeHtml(p.name)}" loading="lazy">
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
  requests.set('performers', (requests.get('performers') || 0) + 1);
  searchDebounce = setTimeout(() => {
    if (state.currentPage !== 'home') {
      showPage('homePage');
      state.currentPage = 'home';
      navigateTo({ page: 'home' });
      return;
    }
    loadPerformers(getSortParams());
  }, 300);
});

$('searchClear').addEventListener('click', () => {
  clearTimeout(searchDebounce);
  $('searchInput').value = '';
  if (state.currentPage === 'home') loadPerformers(getSortParams());
  else navigateTo({ page: 'home' });
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
  navigateTo({ page: 'home' });
});

$qa('.nav-link').forEach(link => {
  link.addEventListener('click', () => {
    navigateTo({ page: link.dataset.page });
  });
});

/* ── SPA History (pushState / popstate) ─────────────────────────── */
let renderedRoute = Navigation.normalizeRoute({ page: 'home' });
let routeRenderId = 0;
history.scrollRestoration = 'manual';

function currentRoute() {
  return Navigation.normalizeRoute(history.state, renderedRoute.depth || 0);
}

function saveCurrentScroll() {
  const route = currentRoute();
  if (route.overlay) return;
  history.replaceState({ ...route, scrollY: Math.max(0, window.scrollY || 0) }, '');
}

function navigateTo(value, { replace = false } = {}) {
  saveCurrentScroll();
  const previous = currentRoute();
  const route = Navigation.normalizeRoute({
    ...value,
    depth: replace ? previous.depth : previous.depth + 1,
    scrollY: Number(value.scrollY) || 0,
  });
  if (Navigation.sameRoute(previous, route) && !replace) {
    if (!route.overlay) window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  history[replace ? 'replaceState' : 'pushState'](route, '');
  renderRoute(route, { restoreScroll: false });
}

function navigateOverlay(overlay, mediaId) {
  const previous = currentRoute();
  const alreadyOpen = Boolean(previous.overlay);
  navigateTo(
    { ...Navigation.withoutOverlay(previous), overlay, mediaId, scrollY: previous.scrollY },
    { replace: alreadyOpen },
  );
}

async function renderRoute(value, { restoreScroll = true, forceBase = false } = {}) {
  const route = Navigation.normalizeRoute(value);
  const renderId = ++routeRenderId;
  const routeStillCurrent = () => renderId === routeRenderId;
  const baseChanged = forceBase || !Navigation.sameBase(renderedRoute, route);
  const previous = renderedRoute;
  renderedRoute = route;
  if (baseChanged) baseEpoch++;

  if (previous.overlay === 'video' && (route.overlay !== 'video' || route.mediaId !== previous.mediaId)) {
    await teardownVideoModal();
  }
  if (previous.overlay === 'photo' && (route.overlay !== 'photo' || route.mediaId !== previous.mediaId)) {
    teardownPhotoModal();
  }
  if (!routeStillCurrent()) return;

  if (baseChanged) {
    if (route.page === 'performer') await openPerformer(route.name, { fromHistory: true, guard: routeStillCurrent });
    else if (route.page === 'favorites') {
      state.currentPage = 'favorites'; showPage('favoritesPage', { resetScroll: false }); await loadFavoritesPage();
    } else if (route.page === 'discover') {
      state.currentPage = 'discover'; showPage('discoverPage', { resetScroll: false }); await loadDiscoverPage();
    } else if (route.page === 'new') {
      state.currentPage = 'new'; showPage('newPage', { resetScroll: false }); await loadNewPage();
    } else {
      state.currentPage = 'home'; showPage('homePage', { resetScroll: false }); await loadPerformers(getSortParams());
    }
  }

  if (!baseChanged && previous.overlay && !route.overlay && route.page === 'favorites') await loadFavoritesPage(favoritesPage);
  if (!baseChanged && previous.overlay && !route.overlay && route.page === 'performer' && globalFavoritesDirty) {
    globalFavoritesDirty = false;
    if ($('photoTab').classList.contains('hidden')) await loadVideos();
    else await loadPhotos();
  }
  if (renderId !== routeRenderId) return;

  if (route.overlay === 'video') await openVideoById(route.mediaId, { fromHistory: true, guard: routeStillCurrent });
  if (route.overlay === 'photo') await openPhotoById(route.mediaId, { fromHistory: true, guard: routeStillCurrent });

  if (restoreScroll && !route.overlay && routeStillCurrent()) {
    requestAnimationFrame(() => { if (routeStillCurrent()) window.scrollTo({ top: route.scrollY || 0, behavior: 'auto' }); });
  }
}

window.addEventListener('popstate', e => {
  renderRoute(e.state || { page: 'home', depth: 0 }, { restoreScroll: true });
});

history.replaceState(Navigation.normalizeRoute({ ...history.state, page: history.state?.page || 'home', depth: 0 }), '');

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
let favoritesPage = 1;

$qa('[data-ftab]').forEach(t => {
  t.addEventListener('click', () => {
    $qa('[data-ftab]').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    currentFavTab = t.dataset.ftab;
    loadFavoritesPage();
  });
});

async function loadFavoritesPage(page = 1) {
  favoritesPage = page;
  const guard = requestGuard('favorites');
  state.videos = []; state.photos = [];
  $qa('[data-ftab]').forEach(t => t.classList.toggle('active', t.dataset.ftab === currentFavTab));
  $('myFavContent').classList.toggle('hidden', currentFavTab !== 'fav-my');
  $('favContent').classList.toggle('hidden', currentFavTab === 'fav-my');
  $('favPagination').innerHTML = '';
  if (currentFavTab === 'fav-my') return loadMyFavorites(page, guard);
  const container = $('favContent');
  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  try {
    if (currentFavTab === 'fav-videos') {
      const { data, total, limit } = await apiFetch(`${API}/favorites?type=video&limit=60&page=${page}`);
      if (!guard()) return;
      renderPagination('favPagination', page, Math.ceil(total / limit), loadFavoritesPage);
      state.videos = data;
      container.innerHTML = '<div class="media-grid videos-grid" id="favVideosGrid"></div>';
      renderVideoCards(data, $('favVideosGrid'), true);
    } else if (currentFavTab === 'fav-photos') {
      const { data, total, limit } = await apiFetch(`${API}/favorites?type=photo&limit=60&page=${page}`);
      if (!guard()) return;
      renderPagination('favPagination', page, Math.ceil(total / limit), loadFavoritesPage);
      state.photos = data;
      container.innerHTML = '<div class="media-grid photos-grid" id="favPhotosGrid"></div>';
      renderPhotoCards(data, $('favPhotosGrid'));
    } else {
      const { data, total } = await apiFetch(`${API}/performers?favorite=1&limit=60&offset=${(page - 1) * 60}`);
      if (!guard()) return;
      renderPagination('favPagination', page, Math.ceil(total / 60), loadFavoritesPage);
      if (!data.length) { container.innerHTML = '<div class="empty-state"><span class="empty-icon">🎭</span><h3>Aucune performeuse favorite</h3></div>'; return; }
      container.innerHTML = '<div class="performers-grid" id="favPerfGrid"></div>';
      state.performers = data;
      renderPerformersInGrid(data, $('favPerfGrid'));
    }
  } catch(e) {
    if (!guard()) return;
    container.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><h3>Erreur</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderPerformersInGrid(performers, grid) {
  grid.innerHTML = performers.map(p => {
    const initials = escapeHtml(p.name.slice(0, 2).toUpperCase());
    const thumbSrc = (p.random_cover_id || p.cover_media_id) ? `/thumb/${p.random_cover_id || p.cover_media_id}` : '';
    return `
      <div class="performer-card" data-performer="${escapeHtml(encodeURIComponent(p.name))}">
        <div class="performer-thumb-wrap">
          ${thumbSrc
            ? `<img class="performer-thumb" src="${thumbSrc}" data-performer-thumb-error alt="${escapeHtml(p.name)}" loading="lazy">
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
  const guard = requestGuard('discover');
  state.videos = []; state.photos = [];
  $('randomVideosGrid').innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  $('randomPhotosGrid').innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  if ($('newMediaGrid')) $('newMediaGrid').innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  try {
    const [vRes, pRes, newRes] = await Promise.all([
      apiFetch(`${API}/random/videos?limit=12`),
      apiFetch(`${API}/random/photos?limit=24`),
      apiFetch(`${API}/new?type=video&limit=12`),
    ]);

    if (!guard()) return;
    state.discoverVideos = vRes.data;
    state.discoverPhotos = pRes.data;
    state.videos = [...vRes.data, ...newRes.data.filter(v => !vRes.data.some(r => r.id === v.id))];
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
    if (!guard()) return;
    $('randomVideosGrid').innerHTML = `<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;
    $('randomPhotosGrid').innerHTML = '';
    $('newMediaGrid').innerHTML = '';
  }
}

$('reshuffleBtn').addEventListener('click', loadDiscoverPage);

/* ══════════════════════════════════════════════════════════════════
   PERFORMER PAGE
   ══════════════════════════════════════════════════════════════════ */

async function openPerformer(encodedName, { fromHistory = false, guard = () => true } = {}) {
  if (!fromHistory) {
    navigateTo({ page: 'performer', name: encodedName });
    return;
  }
  const name = decodeURIComponent(encodedName);
  showPage('performerPage', { resetScroll: false });
  state.currentPage = 'performer';
  state.currentPerformer = null;
  state.videos = []; state.photos = [];
  state.videoTotal = 0; state.photoTotal = 0;
  $('videosGrid').innerHTML = ''; $('photosGrid').innerHTML = '';
  $('videoPagination').innerHTML = ''; $('photoPagination').innerHTML = '';
  $('videoScrollSentinel').classList.add('hidden');
  $('btnFavPerformer').classList.add('hidden');
  $('tabVideoCount').textContent = 'Vidéos'; $('tabPhotoCount').textContent = 'Photos';

  $('performerName').textContent = name;
  $('performerMeta').innerHTML = '<div class="loading-spinner" style="padding:4px 0"><div class="spinner" style="width:18px;height:18px;border-width:2px"></div></div>';

  try {
    const p = await apiFetch(`${API}/performers/${encodeURIComponent(name)}`);
    if (!guard()) return;
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
    favBtn.disabled = false;
    favBtn.classList.toggle('hidden', auth.user?.role !== 'admin');
    favBtn.textContent = p.favorite ? '❤️' : '♡';
    favBtn.classList.toggle('active', !!p.favorite);
  } catch(e) {
    if (!guard()) return;
    $('performerMeta').textContent = 'Erreur lors du chargement : ' + e.message;
    return;
  }

  // Load tag filter scoped to this performer + reset selection
  const tagSel = $('filterVideoTag');
  if (tagSel) tagSel.value = '';
  if (!guard()) return;
  loadVideoTagFilter(name);
  await switchTab('videos');
}

async function switchTab(tab) {
  $qa('.tab[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const isVideo = tab === 'videos';
  $('videoTab').classList.toggle('hidden', !isVideo);
  $('photoTab').classList.toggle('hidden', isVideo);
  $('videoFilters').classList.toggle('hidden', !isVideo);
  $('photoFilters').classList.toggle('hidden', isVideo);

  if (isVideo) return loadVideos();
  return loadPhotos();
}

$qa('.tab[data-tab]').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

/* ── Performer Favorite ─────────────────────────────────────────── */
$('btnFavPerformer').addEventListener('click', async () => {
  if (!state.currentPerformer) return;
  const performer = state.currentPerformer;
  $('btnFavPerformer').disabled = true;
  const guard = requestGuard('performerFavorite');
  try {
    const res = await apiPost(`${API}/performers/${performer.id}/favorite`);
    if (!guard() || performer !== state.currentPerformer) return;
    state.currentPerformer.favorite = res.favorite;
    const btn = $('btnFavPerformer');
    btn.textContent = res.favorite ? '❤️' : '♡';
    btn.classList.toggle('active', !!res.favorite);
    showToast(res.favorite ? 'Ajoutée aux favoris globaux' : 'Retirée des favoris globaux', 'success');
  } catch(e) { if (guard()) showToast('Erreur : ' + e.message, 'error'); }
  finally { if (guard()) $('btnFavPerformer').disabled = false; }
});

/* ── Videos ─────────────────────────────────────────────────────── */
async function loadVideos(page = 1, append = false) {
  if (!state.currentPerformer) return;
  const guard = requestGuard('videos');
  if (!append) { state.videos = []; state.videoTotal = 0; $('videoScrollSentinel').classList.add('hidden'); }
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
    if (!guard()) return;
    state.videoPage = page;
    if (append) {
      state.videos = [...state.videos, ...data];
    } else {
      state.videos = data;
    }
    state.videoTotal = total;

    if (append) {
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
    if (!guard()) return;
    if (append) showToast('Chargement interrompu. Réessayez avec la pagination.', 'error');
    if (!append) grid.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><h3>Erreur</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderSingleVideoCard(v, showPerformer = false) {
  const tagCls = { '4K': 'tag-4k', '1080p': 'tag-hd', '720p': 'tag-hd', 'Long': 'tag-long' };
  const tagsHtml = v.tags && v.tags.length
    ? `<div class="video-tags">${v.tags.map(t => `<span class="tag-badge ${tagCls[t] || ''}">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';
  return `
    <div class="video-card" data-video-id="${v.id}">
      <div class="video-thumb-wrapper">
        <img src="/thumb/${v.id}" alt="${escapeHtml(v.filename)}" loading="lazy"
          data-thumb-id="${v.id}"
          style="width:100%;height:100%;object-fit:cover;display:block">
        <div class="play-overlay"><div class="play-btn">▶</div></div>
        ${v.duration ? `<div class="video-duration">${formatDuration(v.duration)}</div>` : ''}
        ${v.favorite ? '<div class="video-fav-badge" title="Favori global">⭐</div>' : ''}
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
  const guard = requestGuard('tags');
  try {
    const qs = performerName ? `?performer=${encodeURIComponent(performerName)}` : '';
    const { data } = await apiFetch(`${API}/tags${qs}`);
    if (!guard()) return;
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
  if (!state.currentPerformer) return;
  const guard = requestGuard('photos');
  state.photos = [];
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
    if (!guard()) return;
    state.photoPage = page;
    state.photos = data;
    state.photoTotal = total;
    renderPhotoCards(data, grid);
    renderPagination('photoPagination', page, Math.ceil(total / state.photoLimit), p => loadPhotos(p));
  } catch(e) {
    if (!guard()) return;
    grid.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><h3>Erreur</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function renderPhotoCards(photos, grid) {
  if (!photos.length) {
    grid.innerHTML = `<div class="empty-state"><span class="empty-icon">🖼️</span><h3>Aucune photo</h3></div>`;
    return;
  }

  grid.innerHTML = photos.map((ph, idx) => `
    <div class="photo-card" data-photo-id="${ph.id}">
      <img src="/thumb/${ph.id}" alt="${escapeHtml(ph.filename)}" loading="lazy"
        data-photo-fallback="${ph.id}" />
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
    <button class="page-btn" ${current===1?'disabled':''} data-page="${current-1}">‹</button>
    ${pages.map(p => p === '…'
      ? `<span class="page-btn" style="cursor:default">…</span>`
      : `<button class="page-btn ${p===current?'active':''}" data-page="${p}">${p}</button>`
    ).join('')}
    <button class="page-btn" ${current===totalPages?'disabled':''} data-page="${current+1}">›</button>
  `;
  el.querySelectorAll('[data-page]').forEach(button => {
    button.addEventListener('click', () => onPage(Number(button.dataset.page)));
  });
}

/* ── Back button ─────────────────────────────────────────────────── */
$('btnBack').addEventListener('click', () => {
  if (currentRoute().depth > 0) history.back();
  else navigateTo({ page: 'home' }, { replace: true });
});

/* ══════════════════════════════════════════════════════════════════
   VIDEO PLAYER — Cinema Mode
   ══════════════════════════════════════════════════════════════════ */

// Resume positions: mediaId → seconds
const resumeMap = {};
let uiHideTimer = null;
let autoplayTimer = null;
let activeVideoId = null;

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

function openVideo(idx, { fromHistory = false } = {}) {
  const v = state.videos[idx];
  if (!v) return;
  if (!fromHistory) {
    navigateOverlay('video', v.id);
    return;
  }
  state.videoIndex = idx;
  mediaEpoch++;
  clearTimeout(autoplayTimer);
  activeVideoId = v.id;
  const player = $('videoPlayer');
  $('videoError').classList.add('hidden');

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
  favBtn.disabled = false;
  favBtn.textContent = '♡';
  favBtn.classList.remove('active');
  favBtn.dataset.id = v.id;
  favBtn.setAttribute('aria-label', 'Mon favori personnel (F)');
  loadPersonalFavorite(v.id, favBtn);
  const globalFav = $('favGlobalVideo');
  globalFav.dataset.id = v.id;
  globalFav.disabled = false;
  globalFav.classList.toggle('hidden', auth.user?.role !== 'admin');
  globalFav.classList.toggle('active', Boolean(v.favorite));
  globalFav.setAttribute('aria-pressed', String(Boolean(v.favorite)));

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
  player.onloadedmetadata = function () {
    if (activeVideoId !== v.id) return;
    if (resumeMap[v.id] && resumeMap[v.id] > 2 && resumeMap[v.id] < player.duration - 5) {
      player.currentTime = resumeMap[v.id];
    }
    player.play().catch(() => {});
  };

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
  $('commentSubmit').disabled = false;
  $('loadMoreComments').disabled = false;
  commentsTotal = 0;
  $('commentInput').value = '';
  $('commentsError').classList.add('hidden');
  $('loadMoreComments').classList.add('hidden');
  $('commentsList').innerHTML = '';
  $('commentsBody').classList.add('hidden');
  $('commentsToggle').textContent = 'Afficher';

  // Load related videos from same performer
  loadRelatedVideos(v.id);
}

async function teardownVideoModal() {
  mediaEpoch++;
  const epoch = mediaEpoch;
  clearTimeout(autoplayTimer);
  const player = $('videoPlayer');
  // Save position for resume
  if (activeVideoId && player.currentTime > 2) {
    resumeMap[activeVideoId] = player.currentTime;
  }
  activeVideoId = null;
  currentReactionMediaId = null; commentsMediaId = null;
  player.onloadedmetadata = null;
  player.pause();
  player.removeAttribute('src');
  player.load();
  $('videoModal').classList.add('hidden');
  if (document.fullscreenElement && $('videoModal').contains(document.fullscreenElement)) {
    try { await document.exitFullscreen(); } catch (_) {}
  }
  if (document.pictureInPictureElement === player) {
    try { await document.exitPictureInPicture(); } catch (_) {}
  }
  if (epoch !== mediaEpoch) return;
  document.body.style.overflow = '';
  clearTimeout(uiHideTimer);
  // Hide related when closing
  const vpRel = $('vpRelated');
  if (vpRel) vpRel.classList.add('hidden');
}

function closeVideoModal() {
  clearTimeout(autoplayTimer);
  const route = currentRoute();
  if (route.overlay === 'video' && route.depth > 0) history.back();
  else {
    const base = Navigation.withoutOverlay(route);
    history.replaceState(base, '');
    renderedRoute = base;
    teardownVideoModal();
  }
}

/**
 * Fetch and render related videos (same performer) in the player sidebar.
 * @param {number} mediaId
 */
async function loadRelatedVideos(mediaId) {
  const guard = requestGuard('related', true);
  const el = $('vpRelated');
  const grid = $('vpRelatedGrid');
  if (!el || !grid) return;
  el.classList.add('hidden');
  try {
    const { data } = await apiFetch(`${API}/media/${mediaId}/related?limit=8`);
    if (!guard()) return;
    if (!data.length) return;
    el.classList.remove('hidden');
    grid.innerHTML = data.map(r => `
      <div class="related-card" data-video-id="${r.id}">
        <img src="/thumb/${r.id}" alt="${escapeHtml(r.filename)}" loading="lazy"
          data-thumb-id="${r.id}">
        <div class="related-info">
          <div class="related-name" title="${escapeHtml(r.filename)}">${escapeHtml(r.filename)}</div>
          <div class="related-meta">${r.duration ? formatDuration(r.duration) : ''} · ${formatSize(r.size)}</div>
        </div>
      </div>
    `).join('');
  } catch(e) { if (guard()) el.classList.add('hidden'); }
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
      const id = activeVideoId;
      const nextId = state.videos[state.videoIndex + 1].id;
      clearTimeout(autoplayTimer);
      autoplayTimer = setTimeout(() => {
        if (activeVideoId === id && !$('videoModal').classList.contains('hidden')) openVideoById(nextId);
      }, 1200);
    }
  });
  player.addEventListener('error', () => {
    if (!activeVideoId || !player.getAttribute('src')) return;
    clearTimeout(autoplayTimer);
    $('videoError').textContent = 'Lecture impossible : média indisponible ou format non pris en charge.';
    $('videoError').classList.remove('hidden');
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
document.addEventListener('fullscreenchange', () => {
  $('vpFullscreen').setAttribute('aria-label', document.fullscreenElement ? 'Quitter le plein écran' : 'Plein écran');
});

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
  if (!auth.user) { openAuthModal('loginForm'); return; }
  const guard = requestGuard('favCurrentVideo', true);
  const id = $('favCurrentVideo').dataset.id;
  if (!id) return;
  $('favCurrentVideo').disabled = true;
  try {
    const res = await apiPost(`/social/favorites/${id}`);
    if (!guard()) return;
    const btn = $('favCurrentVideo');
    btn.textContent = res.favorited ? '❤️' : '♡';
    btn.classList.toggle('active', !!res.favorited);
    showToast(res.favorited ? 'Ajoutée à mes favoris ❤️' : 'Retirée de mes favoris');
  } catch(e) { if (guard()) showToast('Erreur : ' + e.message, 'error'); }
  finally { if (guard()) $('favCurrentVideo').disabled = false; }
});

/* ══════════════════════════════════════════════════════════════════
   PHOTO LIGHTBOX
   ══════════════════════════════════════════════════════════════════ */

function openPhoto(idx, { fromHistory = false } = {}) {
  const ph = state.photos[idx];
  if (!ph) return;
  if (!fromHistory) {
    navigateOverlay('photo', ph.id);
    return;
  }
  state.lightboxIndex = idx;
  mediaEpoch++;
  $('photoError').classList.add('hidden');
  $('lightboxImg').src = `/photo/${ph.id}`;
  $('lightboxImg').alt = ph.filename;
  $('lightboxTitle').textContent = ph.filename;
  $('lightboxCounter').textContent = `${idx + 1} / ${state.photos.length}`;

  // Set download link
  const dlPhoto = $('dlCurrentPhoto');
  if (dlPhoto) { dlPhoto.href = `/download/${ph.id}`; dlPhoto.setAttribute('download', ph.filename || ''); }

  const favBtn = $('favCurrentPhoto');
  favBtn.disabled = false;
  favBtn.textContent = '♡';
  favBtn.classList.remove('active');
  favBtn.dataset.id = ph.id;
  favBtn.setAttribute('aria-label', 'Mon favori personnel');
  loadPersonalFavorite(ph.id, favBtn);
  const globalFav = $('favGlobalPhoto');
  globalFav.dataset.id = ph.id;
  globalFav.disabled = false;
  globalFav.classList.toggle('hidden', auth.user?.role !== 'admin');
  globalFav.classList.toggle('active', Boolean(ph.favorite));
  globalFav.setAttribute('aria-pressed', String(Boolean(ph.favorite)));

  $('photoModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Preload adjacent photos for smooth navigation
  if (state.photos[idx + 1]) new Image().src = `/photo/${state.photos[idx + 1].id}`;
  if (state.photos[idx - 1]) new Image().src = `/photo/${state.photos[idx - 1].id}`;

  // Track view
  apiPost(`${API}/media/${ph.id}/view`).catch(() => {});
}

function teardownPhotoModal() {
  mediaEpoch++;
  $('photoModal').classList.add('hidden');
  document.body.style.overflow = '';
  $('lightboxImg').removeAttribute('src');
}

function closePhotoModal() {
  const route = currentRoute();
  if (route.overlay === 'photo' && route.depth > 0) history.back();
  else {
    const base = Navigation.withoutOverlay(route);
    history.replaceState(base, '');
    renderedRoute = base;
    teardownPhotoModal();
  }
}

$('closePhoto').addEventListener('click', closePhotoModal);
$('photoModal').addEventListener('click', e => { if (e.target === $('photoModal')) closePhotoModal(); });
$('lightboxImg').addEventListener('error', () => {
  if (!$('photoModal').classList.contains('hidden')) $('photoError').classList.remove('hidden');
});
$('photoPrev').addEventListener('click', () => { if (state.lightboxIndex > 0) openPhoto(state.lightboxIndex - 1); });
$('photoNext').addEventListener('click', () => { if (state.lightboxIndex < state.photos.length - 1) openPhoto(state.lightboxIndex + 1); });

// Favorite current photo
$('favCurrentPhoto').addEventListener('click', async () => {
  if (!auth.user) { openAuthModal('loginForm'); return; }
  const guard = requestGuard('favCurrentPhoto', true);
  const id = $('favCurrentPhoto').dataset.id;
  if (!id) return;
  $('favCurrentPhoto').disabled = true;
  try {
    const res = await apiPost(`/social/favorites/${id}`);
    if (!guard()) return;
    const btn = $('favCurrentPhoto');
    btn.textContent = res.favorited ? '❤️' : '♡';
    btn.classList.toggle('active', !!res.favorited);
    showToast(res.favorited ? 'Ajoutée à mes favoris ❤️' : 'Retirée de mes favoris');
  } catch(e) { if (guard()) showToast('Erreur : ' + e.message, 'error'); }
  finally { if (guard()) $('favCurrentPhoto').disabled = false; }
});

for (const id of ['favGlobalVideo', 'favGlobalPhoto']) {
  $(id).addEventListener('click', async () => {
    const button = $(id), mediaId = Number(button.dataset.id);
    if (!mediaId || auth.user?.role !== 'admin') return;
    const guard = requestGuard(id, true);
    button.disabled = true;
    try {
      const result = await apiPost(`${API}/media/${mediaId}/favorite`);
      if (!guard()) return;
      globalFavoritesDirty = true;
      for (const media of [...state.videos, ...state.photos]) if (media.id === mediaId) media.favorite = result.favorite;
      button.classList.toggle('active', Boolean(result.favorite));
      button.setAttribute('aria-pressed', String(Boolean(result.favorite)));
      showToast(result.favorite ? 'Ajouté aux favoris globaux' : 'Retiré des favoris globaux');
    } catch(e) { if (guard()) showToast(e.message, 'error'); }
    finally { if (guard()) button.disabled = false; }
  });
}

/* ══════════════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ══════════════════════════════════════════════════════════════════ */

document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing || e.altKey || e.metaKey) return;
  if (e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
  if (e.target.closest('button, a, [role="button"]') && (e.key === ' ' || e.key === 'Enter')) return;
  if (e.ctrlKey && !['ArrowLeft', 'ArrowRight', 'k'].includes(e.key)) return;
  if (['authModal', 'profileModal', 'manageModal', 'statsModal'].some(id => !$(id).classList.contains('hidden'))) return;
  // Video modal
  if (!$('videoModal').classList.contains('hidden')) {
    const p = _vp();
    switch(e.key) {
      case 'Escape':
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else closeVideoModal();
        break;
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
  const guard = requestGuard('manage');
  $('manageModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  try {
    const stats = await apiFetch(`${API}/stats`);
    if (!guard()) return;
    $('mediaDir').textContent = stats.mediaDir || 'Non configuré';
  } catch(e) {
    if (!guard()) return;
    $('mediaDir').textContent = 'Voir .env (MEDIA_DIR)';
  }
});

$('closeManage').addEventListener('click', () => {
  $('manageModal').classList.add('hidden');
  document.body.style.overflow = '';
});

$('manageModal').addEventListener('click', e => {
  if (e.target === $('manageModal')) {
    $('manageModal').classList.add('hidden');
    document.body.style.overflow = '';
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
  $('scanBannerCancel').disabled = false;
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

  let polling = false;
  const session = sessionEpoch;
  state.scanInterval = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const p = await apiFetch(`${API}/scan/progress`);
      if (session !== sessionEpoch) return;
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
        } else if (p.error || p.errors > 0) {
          $('progressText').textContent = `Scan terminé en erreur : ${p.error || `${p.errors} fichier(s) en erreur`}`;
          showToast('Scan terminé avec des erreurs, vérifiez le résultat.', 'error');
        } else {
          $('progressFill').style.width = '100%';
          $('progressText').textContent = `✅ ${modeLabel} — Terminé — ${p.done} fichiers indexés${p.errors ? ` (${p.errors} erreurs)` : ''}`;
          showToast(`Scan terminé — ${p.done} fichiers`, 'success');
        }
        if (state.currentPage === 'home') loadPerformers(getSortParams());
        loadHeroStats();
      }
    } catch(e) {
      if (session !== sessionEpoch) return;
      clearInterval(state.scanInterval);
      state.scanInterval = null;
      hideScanRunning();
      showToast('Erreur lors du suivi du scan', 'error');
    } finally { polling = false; }
  }, 800);
}

// Check on page load if a scan is already running
async function checkScanOnLoad() {
  const session = sessionEpoch;
  try {
    const p = await apiFetch(`${API}/scan/progress`);
    if (p.running && session === sessionEpoch && auth.user?.role === 'admin') {
      startScanPolling();
    }
  } catch(e) { /* ignore */ }
}

async function launchScan(mode) {
  const session = sessionEpoch;
  showScanRunning();
  try {
    await apiPost(`${API}/scan?mode=${mode}`);
    if (session !== sessionEpoch) return;
    showToast(`Scan ${MODE_LABELS[mode]} lancé !`);
    startScanPolling();
  } catch(e) {
    if (session !== sessionEpoch) return;
    if (e.status === 409) {
      try {
        const progress = await apiFetch(`${API}/scan/progress`);
        if (session !== sessionEpoch) return;
        if (progress.running === true) {
          updateScanUI(progress);
          startScanPolling();
          return;
        }
      } catch (_) { /* A conflict alone does not prove a scan is running. */ }
      if (session !== sessionEpoch) return;
    }
    hideScanRunning();
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
  const guard = requestGuard('stats');
  $('statsModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  $('statsGrid').innerHTML = '<div class="loading-spinner" style="padding:20px 0;grid-column:1/-1"><div class="spinner"></div></div>';

  try {
    const s = await apiFetch(`${API}/stats`);
    if (!guard()) return;
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
    if (guard()) $('statsGrid').innerHTML = `<p class="empty-state">${escapeHtml(e.message)}</p>`;
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
  requireAuth: true,
};

function resetUserState() {
  sessionEpoch++; baseEpoch++; routeRenderId++;
  auth.user = null; contentInitialized = false;
  teardownVideoModal(); teardownPhotoModal();
  for (const key of Object.keys(resumeMap)) delete resumeMap[key];
  state.currentPerformer = null;
  state.performers = []; state.videos = []; state.photos = [];
  state.discoverVideos = []; state.discoverPhotos = [];
  state.videoTotal = 0; state.photoTotal = 0;
  clearInterval(state.scanInterval); state.scanInterval = null;
  clearTimeout(searchDebounce);
  hideScanRunning();
  currentFavTab = 'fav-videos';
  favoritesPage = 1; globalFavoritesDirty = false;
  const route = Navigation.withoutOverlay(currentRoute());
  history.replaceState(route, ''); renderedRoute = route;
  for (const id of ['performersGrid', 'videosGrid', 'photosGrid', 'favContent', 'myFavContent',
    'randomVideosGrid', 'randomPhotosGrid', 'newMediaGrid', 'newPageGrid', 'commentsList', 'vpRelatedGrid',
    'heroStats', 'statsGrid', 'performerMeta', 'performerName', 'userUname', 'profileEmailSmall',
    'performersPagination', 'videoPagination', 'photoPagination', 'favPagination', 'newPagePagination',
    'profileRoleBadge', 'profileAvatarBig', 'profileCreatedAt', 'profileLastLogin', 'videoTitle', 'videoMeta',
    'lightboxTitle', 'performerCount']) $(id).textContent = '';
  $qa('#profileModal input, #profileModal textarea, #authModal input, #commentInput').forEach(el => { el.value = ''; });
  $qa('.modal-overlay').forEach(el => el.classList.add('hidden'));
  $('userDropdown').classList.add('hidden');
  $('btnFavPerformer').classList.add('hidden');
  $('favGlobalVideo').classList.add('hidden'); $('favGlobalPhoto').classList.add('hidden');
  for (const id of ['favCurrentVideo', 'favCurrentPhoto']) { $(id).textContent = '♡'; $(id).classList.remove('active'); delete $(id).dataset.id; }
  $('vpLikeCount').textContent = '0'; $('vpDislikeCount').textContent = '0';
}

async function authInit() {
  // 1. Check server config (registration open?)
  try {
    const response = await fetch('/auth/config');
    if (!response.ok) throw new Error('Configuration indisponible');
    const cfg = await response.json();
    auth.requireAuth = cfg.require_auth !== false;
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
  try {
    const r = await fetch('/auth/me');
    if (!r.ok) { updateAuthUI(null); return; }
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
    resetUserState();
    auth.user = d.user;
    updateAuthUI(d.user);
    authModal.classList.add('hidden');
    document.body.style.overflow = '';
    showToast('Bienvenue, ' + d.user.username + ' !', 'success');
    initializeContent();
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
    resetUserState();
    auth.user = d.user;
    updateAuthUI(d.user);
    authModal.classList.add('hidden');
    document.body.style.overflow = '';
    showToast('Compte cree ! Bienvenue, ' + d.user.username + ' !', 'success');
    initializeContent();
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

$('ddLogout').addEventListener('click', async () => {
  try {
    await checkedFetch('/auth/logout', { method: 'POST' });
    resetUserState(); updateAuthUI(null);
    window.location.reload();
  } catch(e) { showToast('Déconnexion non confirmée : ' + e.message, 'error'); }
});

$('ddFavorites').addEventListener('click', e => {
  e.preventDefault();
  $('userDropdown').classList.add('hidden');
  currentFavTab = 'fav-my';
  if (state.currentPage === 'favorites') { loadFavoritesPage(); return; }
  navigateTo({ page: 'favorites' });
});

$('ddProfile').addEventListener('click', () => {
  $('userDropdown').classList.add('hidden');
  openProfileModal();
});

/* ── Helper: show favorites page ────────────────────────────────── */
function showFavoritesPage() {
  navigateTo({ page: 'favorites' });
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

  const guard = requestGuard('profile');
  apiFetch('/auth/me').then(u => {
    if (!guard() || profileModal.classList.contains('hidden')) return;
    $('profileCreatedAt').textContent = u.created_at ? new Date(u.created_at).toLocaleDateString('fr-FR') : '-';
    $('profileLastLogin').textContent = u.last_login ? new Date(u.last_login).toLocaleDateString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '-';
  }).catch(() => {});

  profileModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

$('closeProfile').addEventListener('click', () => { profileModal.classList.add('hidden'); document.body.style.overflow = ''; });
profileModal.addEventListener('click', e => { if (e.target === profileModal) { profileModal.classList.add('hidden'); document.body.style.overflow = ''; } });

$('saveProfileBtn').addEventListener('click', async () => {
  const guard = requestGuard('profileSave');
  const err = $('profileError');
  err.classList.add('hidden');
  const username = $('profileUsername').value.trim();
  const bio = $('profileBio').value.trim();
  if (!username) { err.textContent = 'Le nom utilisateur est requis'; err.classList.remove('hidden'); return; }
  try {
    const r = await checkedFetch('/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, bio }),
    });
    const d = await r.json();
    if (!guard()) return;
    if (!r.ok) { err.textContent = d.error; err.classList.remove('hidden'); return; }
    auth.user = { ...auth.user, ...d };
    updateAuthUI(auth.user);
    showToast('Profil mis a jour', 'success');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
});

$('changePwBtn').addEventListener('click', async () => {
  const session = sessionEpoch;
  const err = $('profilePwError');
  err.classList.add('hidden');
  const cur = $('profileCurrentPw').value;
  const nw = $('profileNewPw').value;
  const nwc = $('profileNewPwConfirm').value;
  if (!cur || !nw) { err.textContent = 'Remplissez tous les champs'; err.classList.remove('hidden'); return; }
  if (nw !== nwc) { err.textContent = 'Les mots de passe ne correspondent pas'; err.classList.remove('hidden'); return; }
  if (nw.length < 12) { err.textContent = 'Minimum 12 caracteres'; err.classList.remove('hidden'); return; }
  try {
    const r = await checkedFetch('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: cur, newPassword: nw }),
    });
    const d = await r.json();
    if (session !== sessionEpoch) return;
    if (!r.ok) { err.textContent = d.error; err.classList.remove('hidden'); return; }
    $('profileCurrentPw').value = '';
    $('profileNewPw').value = '';
    $('profileNewPwConfirm').value = '';
    resetUserState();
    window.location.reload();
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
});

/* ── Personal Favorites Tab ─────────────────────────────────────── */
async function loadMyFavorites(page = 1, guard = requestGuard('favorites')) {
  const el = $('myFavContent');
  el.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Chargement...</p></div>';
  el.classList.remove('hidden');
  $('favContent').classList.add('hidden');
  if (!auth.user) { el.textContent = 'Connectez-vous pour voir vos favoris personnels.'; return; }

  try {
    const { data, total, limit } = await apiFetch(`/social/favorites?limit=60&page=${page}`);
    if (!guard()) return;
    state.videos = data.filter(m => m.type === 'video');
    state.photos = data.filter(m => m.type === 'photo');
    renderPagination('favPagination', page, Math.ceil(total / limit), loadFavoritesPage);
    if (!data || !data.length) {
      el.innerHTML = '<div class="empty-state"><p>Aucun favori personnel pour l\'instant. Utilisez le cœur du lecteur ou de la visionneuse.</p></div>';
      return;
    }
    const videos = data.filter(m => m.type === 'video');
    const photos = data.filter(m => m.type === 'photo');
    let html = '';
    if (videos.length) {
      html += '<h3 class="subsection-title">Videos (' + videos.length + ')</h3>';
      html += '<div class="media-grid videos-grid">' + videos.map(v => renderSingleVideoCard(v, true)).join('') + '</div>';
    }
    if (photos.length) {
      html += '<h3 class="subsection-title" style="margin-top:24px">Photos (' + photos.length + ')</h3>';
      html += '<div class="media-grid photos-grid">' + photos.map(p =>
        '<div class="media-card photo-card" data-photo-id="' + p.id + '">' +
        '<div class="media-thumb-wrap"><img src="/thumb/' + p.id + '" loading="lazy"></div>' +
        '<div class="media-info"><span class="media-name">' + escapeHtml(p.filename) + '</span></div>' +
        '</div>'
      ).join('') + '</div>';
    }
    el.innerHTML = html;
  } catch(ex) {
    if (!guard()) return;
    el.innerHTML = '<div class="empty-state"><p>Erreur : ' + escapeHtml(ex.message) + '</p></div>';
  }
}

async function openVideoById(id, { fromHistory = false, guard = () => true } = {}) {
  if (!fromHistory) { navigateOverlay('video', id); return; }
  const idx = state.videos.findIndex(v => v.id === id);
  if (idx >= 0) { if (guard()) openVideo(idx, { fromHistory }); return; }
  try {
    const info = await apiFetch('/api/media/' + id);
    if (!guard()) return;
    if (info.type !== 'video') throw new Error('Ce média n’est pas une vidéo');
    state.videos = [...state.videos, info]; openVideo(state.videos.length - 1, { fromHistory });
  } catch(e) {
    if (!guard()) return;
    showToast('Média indisponible : ' + e.message, 'error');
    const base = Navigation.withoutOverlay(currentRoute());
    history.replaceState(base, ''); renderedRoute = base;
  }
}
window.openVideoById = openVideoById;

async function openPhotoById(id, { fromHistory = false, guard = () => true } = {}) {
  if (!fromHistory) { navigateOverlay('photo', id); return; }
  const idx = state.photos.findIndex(p => p.id === id);
  if (idx >= 0) { if (guard()) openPhoto(idx, { fromHistory }); return; }
  try {
    const info = await apiFetch('/api/media/' + id);
    if (!guard()) return;
    if (info.type !== 'photo') throw new Error('Ce média n’est pas une photo');
    state.photos = [...state.photos, info]; openPhoto(state.photos.length - 1, { fromHistory });
  } catch(e) {
    if (!guard()) return;
    showToast('Média indisponible : ' + e.message, 'error');
    const base = Navigation.withoutOverlay(currentRoute());
    history.replaceState(base, ''); renderedRoute = base;
  }
}
window.openPhotoById = openPhotoById;

/* ══════════════════════════════════════════════════════════════════
   REACTIONS (like/dislike)
   ══════════════════════════════════════════════════════════════════ */
let currentReactionMediaId = null;

async function loadReactions(mediaId) {
  const guard = requestGuard('reactions', true);
  currentReactionMediaId = mediaId;
  const likeBtn = $('vpLikeBtn');
  const dislikeBtn = $('vpDislikeBtn');
  likeBtn.disabled = false; dislikeBtn.disabled = false;
  likeBtn.classList.remove('active-reaction');
  dislikeBtn.classList.remove('active-reaction');
  $('vpLikeCount').textContent = '…'; $('vpDislikeCount').textContent = '…';
  try {
    const d = await apiFetch(`/social/reactions/${mediaId}`);
    if (!guard()) return;
    $('vpLikeCount').textContent = d.likes;
    $('vpDislikeCount').textContent = d.dislikes;
    if (d.userReaction === 'like') likeBtn.classList.add('active-reaction');
    if (d.userReaction === 'dislike') dislikeBtn.classList.add('active-reaction');
  } catch(e) { if (guard()) { $('vpLikeCount').textContent = '?'; $('vpDislikeCount').textContent = '?'; } }
}

async function sendReaction(type) {
  if (!auth.user) { openAuthModal('loginForm'); return; }
  if (!currentReactionMediaId) return;
  if ($('vpLikeBtn').disabled) return;
  $('vpLikeBtn').disabled = true; $('vpDislikeBtn').disabled = true;
  const guard = requestGuard('reactions', true);
  try {
    const r = await checkedFetch(`/social/reactions/${currentReactionMediaId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    });
    const d = await r.json();
    if (!guard()) return;
    $('vpLikeCount').textContent = d.likes;
    $('vpDislikeCount').textContent = d.dislikes;
    $('vpLikeBtn').classList.toggle('active-reaction', d.userReaction === 'like');
    $('vpDislikeBtn').classList.toggle('active-reaction', d.userReaction === 'dislike');
  } catch(e) { if (guard()) showToast('Réaction non enregistrée : ' + e.message, 'error'); }
  finally { if (guard()) { $('vpLikeBtn').disabled = false; $('vpDislikeBtn').disabled = false; } }
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
  const guard = requestGuard('comments', true);
  commentsMediaId = mediaId;
  const page = reset ? 1 : commentsPage + 1;
  if (reset) { commentsPage = 0; $('commentsList').innerHTML = ''; }

  $('commentForm').classList.toggle('hidden', !auth.user);

  const loadMore = $('loadMoreComments');
  loadMore.disabled = true;
  $('commentsError').classList.add('hidden');
  try {
    const { data, total } = await apiFetch(`/social/comments/${mediaId}?page=${page}&limit=${COMMENTS_LIMIT}`);
    if (!guard()) return;
    commentsPage = page; commentsTotal = total;
    data.forEach(c => appendComment(c));
    loadMore.classList.toggle('hidden', page * COMMENTS_LIMIT >= total);
  } catch(e) {
    if (!guard()) return;
    $('commentsError').textContent = 'Commentaires indisponibles : ' + e.message;
    $('commentsError').classList.remove('hidden');
    loadMore.classList.remove('hidden');
  } finally { if (guard()) loadMore.disabled = false; }
}

function appendComment(c) {
  if ($(`comment-${c.id}`)) return;
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
        ${canDelete ? `<button class="btn-comment-del" data-comment-delete="${c.id}" aria-label="Supprimer le commentaire">✕</button>` : ''}
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
  const guard = requestGuard('commentDelete', true);
  try {
    await checkedFetch(`/social/comments/${id}`, { method: 'DELETE' });
    if (guard()) await loadComments(commentsMediaId);
  } catch(e) { if (guard()) showToast('Suppression refusée : ' + e.message, 'error'); }
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
  if (!txt || !commentsMediaId) return;
  const guard = requestGuard('commentSubmit', true);
  const mediaId = commentsMediaId;
  $('commentSubmit').disabled = true;
  try {
    const r = await checkedFetch(`/social/comments/${mediaId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: txt }),
    });
    await r.json();
    if (!guard()) return;
    $('commentInput').value = '';
    await loadComments(mediaId);
  } catch(e) {
    if (guard()) { $('commentsError').textContent = 'Envoi refusé : ' + e.message; $('commentsError').classList.remove('hidden'); }
  } finally { if (guard()) $('commentSubmit').disabled = false; }
});

$('loadMoreComments').addEventListener('click', () => loadComments(commentsMediaId, false));

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

/* ── Mobile bottom nav ──────────────────────────────────────── */
function updateMobileNav(page) {
  $qa('.mobile-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });
}

$qa('.mobile-nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    // Delegate to the existing desktop nav link handler
    const desktopLink = $q(`.nav-link[data-page="${page}"]`);
    if (desktopLink) desktopLink.click();
    updateMobileNav(page);
  });
});

// Patch showPage to also sync the mobile nav highlights
const _origShowPage = showPage;
// Override can't reassign const, so we hook via nav-link clicks instead.
// Keep mobile nav in sync whenever desktop nav updates:
$qa('.nav-link').forEach(link => {
  link.addEventListener('click', () => {
    updateMobileNav(link.dataset.page);
  });
});

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
  const guard = requestGuard('new');
  state.videos = []; state.photos = [];
  const grid = $('newPageGrid');
  if (!grid) return;
  $('newPagePagination').textContent = 'Les 80 derniers médias indexés. Retrouvez toute la collection par performeuse.';
  grid.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Chargement…</p></div>';
  const type = currentNewTab === 'new-videos' ? 'video' : 'photo';
  try {
    const { data } = await apiFetch(`${API}/new?type=${type}&limit=80`);
    if (!guard()) return;
    grid.className = 'media-grid ' + (type === 'video' ? 'videos-grid' : 'photos-grid');
    if (type === 'video') {
      state.videos = data;
      renderVideoCards(data, grid, true);
    } else {
      state.photos = data;
      renderPhotoCards(data, grid);
    }
  } catch(e) {
    if (!guard()) return;
    grid.innerHTML = `<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;
  }
}

// Restore sort preferences from previous session
function restoreSortPrefs() {
  const sp = localStorage.getItem('xflix_sort_performers');
  const sv = localStorage.getItem('xflix_sort_videos');
  const sph = localStorage.getItem('xflix_sort_photos');
  for (const [id, value] of [['sortPerformers', sp], ['sortVideos', sv], ['sortPhotos', sph]]) {
    if (value && [...$(id).options].some(option => option.value === value)) $(id).value = value;
  }
}

let contentInitialized = false;
function initializeContent() {
  if (contentInitialized) return;
  contentInitialized = true;
  renderRoute(currentRoute(), { restoreScroll: true, forceBase: true });
  loadHeroStats();
  if (auth.user?.role === 'admin') checkScanOnLoad();
}

async function bootstrap() {
  initTheme();
  restoreSortPrefs();
  await authInit();
  if (auth.user || !auth.requireAuth) initializeContent();
  else if (!$('resetToken').value) openAuthModal('loginForm');
}

bootstrap();
