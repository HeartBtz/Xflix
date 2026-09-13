(function exposeNavigationState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XflixNavigation = api;
})(typeof window !== 'undefined' ? window : globalThis, function createNavigationState() {
  'use strict';

  const VALID_PAGES = new Set(['home', 'favorites', 'discover', 'new', 'performer']);
  const VALID_OVERLAYS = new Set(['video', 'photo']);

  function normalizeRoute(value, fallbackDepth = 0) {
    const input = value && typeof value === 'object' ? value : {};
    const page = VALID_PAGES.has(input.page) ? input.page : 'home';
    const route = {
      xflix: true,
      page,
      depth: Number.isInteger(input.depth) && input.depth >= 0 ? input.depth : fallbackDepth,
      scrollY: Number.isFinite(Number(input.scrollY)) && Number(input.scrollY) >= 0
        ? Number(input.scrollY)
        : 0,
    };

    if (page === 'performer' && typeof input.name === 'string' && input.name) {
      route.name = input.name;
    } else if (page === 'performer') {
      route.page = 'home';
    }

    if (VALID_OVERLAYS.has(input.overlay) && Number.isSafeInteger(Number(input.mediaId)) && Number(input.mediaId) > 0) {
      route.overlay = input.overlay;
      route.mediaId = Number(input.mediaId);
    }
    return route;
  }

  function sameBase(a, b) {
    const left = normalizeRoute(a);
    const right = normalizeRoute(b);
    return left.page === right.page && (left.page !== 'performer' || left.name === right.name);
  }

  function sameRoute(a, b) {
    const left = normalizeRoute(a);
    const right = normalizeRoute(b);
    return sameBase(left, right)
      && left.overlay === right.overlay
      && left.mediaId === right.mediaId;
  }

  function withoutOverlay(value) {
    const route = normalizeRoute(value);
    delete route.overlay;
    delete route.mediaId;
    return route;
  }

  function withOverlay(value, overlay, mediaId) {
    return normalizeRoute({ ...withoutOverlay(value), overlay, mediaId });
  }

  return { normalizeRoute, sameBase, sameRoute, withoutOverlay, withOverlay };
});
