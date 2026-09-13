'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nav = require('../public/js/navigation-state');

test('normalizes unknown or incomplete routes to home', () => {
  assert.deepEqual(nav.normalizeRoute(null), { xflix: true, page: 'home', depth: 0, scrollY: 0 });
  assert.equal(nav.normalizeRoute({ page: 'performer' }).page, 'home');
});

test('keeps a valid performer route and its scroll position', () => {
  assert.deepEqual(nav.normalizeRoute({ page: 'performer', name: 'Jane%20Doe', depth: 2, scrollY: 417 }), {
    xflix: true, page: 'performer', name: 'Jane%20Doe', depth: 2, scrollY: 417,
  });
});

test('adds and removes a media overlay without changing the underlying page', () => {
  const base = { page: 'performer', name: 'Jane', depth: 3, scrollY: 80 };
  const video = nav.withOverlay(base, 'video', 42);
  assert.equal(video.page, 'performer');
  assert.equal(video.name, 'Jane');
  assert.equal(video.overlay, 'video');
  assert.equal(video.mediaId, 42);
  assert.deepEqual(nav.withoutOverlay(video), nav.normalizeRoute(base));
});

test('compares base routes separately from overlays', () => {
  const base = { page: 'performer', name: 'Jane' };
  const video = { ...base, overlay: 'video', mediaId: 1 };
  const nextVideo = { ...base, overlay: 'video', mediaId: 2 };
  assert.equal(nav.sameBase(video, nextVideo), true);
  assert.equal(nav.sameRoute(video, nextVideo), false);
});

test('rejects invalid overlay ids', () => {
  const route = nav.normalizeRoute({ page: 'home', overlay: 'video', mediaId: '../etc/passwd' });
  assert.equal(route.overlay, undefined);
  assert.equal(route.mediaId, undefined);
});
