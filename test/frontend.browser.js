// Invoked with a Playwright page by the browser tool; no package dependency.
// All API/media requests are intercepted. Non-local requests are aborted.
module.exports = async function frontendBrowserTests(page, origin = 'http://127.0.0.1:18765') {
  const results = [], errors = [], calls = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  page.on('pageerror', error => errors.push(error.message));
  const user = { id: 1, username: 'Fixture admin', email: 'fixture@example.invalid', role: 'admin' };
  const malicious = 'A" data-injected="yes\' <tag>';
  const video = id => ({ id, type: 'video', filename: `Video ${id} "quoted"`, performer_name: 'Alpha', size: 1024, duration: 120 });
  const photo = id => ({ id, type: 'photo', filename: `Photo ${id}`, performer_name: 'Alpha', size: 512 });
  let loggedIn = true, failComments = false, failAppend = false, scanRunning = false, failSettings = false;
  let dupMode = 'error', delayedFavorite = false, failDelete = true, scanConflict = false;
  let deleteError = { error: 'Deletion failed' };
  const settings = { smtp_host: 'smtp.fixture.invalid', smtp_port: '587', smtp_user: 'fixture', smtp_secure: 'false', smtp_pass: 'configured' };
  const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  await page.route('**/*', async route => {
    const req = route.request();
    if (!req.url().startsWith(origin + '/')) return route.abort();
    const [p, query = ''] = req.url().slice(origin.length).split('?');
    const url = { search: '?' + query, searchParams: { get(key) {
      const match = new RegExp('(?:^|&)' + key + '=([^&]*)').exec(query);
      return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : null;
    } } };
    if (p === '/' || /\.(html|js|css)$/.test(p)) return route.continue();
    calls.push({ path: p, search: url.search, method: req.method(), body: req.postData() });
    if (p === '/auth/config') return json(route, { require_auth: true, allow_registration: true });
    if (p === '/auth/me') return json(route, loggedIn ? user : { error: 'Session expired' }, loggedIn ? 200 : 401);
    if (p === '/auth/login') { loggedIn = true; return json(route, { user: { ...user, username: 'Reconnected' } }); }
    if (p === '/auth/logout') { loggedIn = false; return json(route, { ok: true }); }
    if (p === '/api/expire') { loggedIn = false; return json(route, { error: 'Session expired' }, 401); }
    if (p === '/api/stats') return json(route, { performers: 125, videos: 200, photos: 100, totalSize: 4096 });
    if (p === '/api/scan/progress') return json(route, { running: scanRunning, total: 10, done: 3, mode: 'all' });
    if (p === '/api/scan') {
      if (scanConflict) return json(route, { error: 'Maintenance busy' }, 409);
      scanRunning = true; return json(route, { message: 'started' });
    }
    if (p === '/api/scan/cancel') { scanRunning = false; return json(route, { message: 'requested' }); }
    if (p === '/api/performers') {
      const q = url.searchParams.get('q');
      if (q === 'old') await page.waitForTimeout(400);
      const offset = Number(url.searchParams.get('offset') || 0);
      return json(route, { data: [{ id: offset + 1, name: q || malicious, video_count: 3, photo_count: 1 }], total: 125 });
    }
    if (/^\/api\/performers\/[^/]+$/.test(p)) {
      if (p.endsWith('/Slow')) await page.waitForTimeout(400);
      if (p.endsWith('/missing')) return json(route, { error: 'Performer not found' }, 404);
      return json(route, { id: 1, name: decodeURIComponent(p.split('/').pop()), video_count: 150, photo_count: 1 });
    }
    if (p.endsWith('/videos')) {
      if (failAppend && url.searchParams.get('page') === '2') return json(route, { error: 'Append failed' }, 500);
      return json(route, { data: [video(11), video(12)], total: 150, page: 1, limit: 50 });
    }
    if (p.endsWith('/photos')) return json(route, { data: [photo(21)], total: 1, page: 1, limit: 100 });
    if (p === '/api/tags') return json(route, { data: [] });
    if (p === '/api/new') return json(route, { data: url.searchParams.get('type') === 'photo' ? [photo(21)] : [video(11)] });
    if (p === '/api/favorites' || p === '/social/favorites') return json(route, {
      data: url.searchParams.get('type') === 'photo' ? [photo(21)] : [video(11), video(12), ...(p.startsWith('/social') ? [photo(21)] : [])], total: 125, limit: 60 });
    if (/^\/social\/favorites\/\d+$/.test(p)) {
      if (delayedFavorite && p.endsWith('/11')) await page.waitForTimeout(400);
      return json(route, { favorited: p.endsWith('/11') });
    }
    if (p.startsWith('/social/reactions/')) return json(route, { likes: 0, dislikes: 0, userReaction: null });
    if (p.startsWith('/social/comments/')) return json(route, failComments ? { error: 'Comments unavailable' } : { data: [], total: 0 }, failComments ? 500 : 200);
    if (p.endsWith('/related')) return json(route, { data: [video(99)] });
    if (p.endsWith('/view')) return json(route, { ok: true });
    if (p.endsWith('/favorite')) return json(route, { favorite: true });
    if (/^\/api\/media\/\d+$/.test(p)) return json(route, video(Number(p.split('/').pop())));
    if (/^\/(thumb|photo)\//.test(p)) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#242429"/></svg>' });
    if (p.startsWith('/stream/')) return route.fulfill({ status: 404, body: '' });
    if (p === '/admin/stats') return json(route, { users: 1, media: 3, comments: 0, reactions: 0 });
    if (p === '/admin/settings') {
      if (req.method() === 'GET') return json(route, settings);
      if (req.method() === 'PUT') {
        if (failSettings) return json(route, { error: 'Settings PUT failed' }, 500);
        const body = JSON.parse(req.postData());
        const changed = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_secure'].some(key => key in body && body[key] !== settings[key]);
        if (changed && !body.smtp_pass) settings.smtp_pass = '';
        Object.assign(settings, body);
        if (body.smtp_pass) settings.smtp_pass = 'configured';
        return json(route, { message: 'Settings saved' });
      }
    }
    if (p === '/admin/duplicates/scan') {
      if (dupMode === 'pending') await page.waitForTimeout(1500);
      return route.fulfill({ contentType: 'text/event-stream', body: dupMode === 'empty' ? 'data: {"status":"done","groups":[],"count":0}\n\n' : 'data: {"status":"error","error":"Fixture failure"}\n\n' });
    }
    if (p === '/admin/media') return json(route, { data: [{ ...video(11), file_path: '/fixture/video.mp4' }], total: 1 });
    if (p === '/admin/media/11') return json(route, failDelete ? deleteError : { deleted: 1 }, failDelete ? 409 : 200);
    return json(route, { error: 'Unhandled fixture: ' + p }, 404);
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + '/?fixture=' + Math.random());
  await page.locator('.performer-card').first().waitFor();
  check(await page.locator('[data-injected]').count() === 0, 'Attribute injection');
  check(await page.locator('.performer-card').first().getAttribute('data-name') === malicious, 'Escaping changed data');
  await page.locator('#performersPagination [data-page="2"]').first().click();
  check(calls.some(c => c.path === '/api/performers' && c.search.includes('offset=60')), 'Performer pagination missing');
  results.push('attribute escaping and collection pagination');

  await page.evaluate(async () => {
    const old = renderRoute({ page: 'performer', name: 'Slow' });
    await renderRoute({ page: 'home' }); await old;
  });
  check(await page.locator('#homePage').isVisible(), 'Pending navigation did not return home');

  await page.evaluate(async () => { const old = loadPerformers({ q: 'old' }); await loadPerformers({ q: 'new' }); await old; });
  check(await page.locator('#sectionTitle').textContent() === 'Résultats pour « new »', 'Stale search overwrote latest');
  await page.locator('.performer-card').first().focus();
  await page.keyboard.press('Enter');
  await page.locator('#videosGrid .video-card').first().waitFor();
  await page.evaluate(() => openPerformer('missing'));
  await page.waitForFunction(() => document.getElementById('performerMeta').textContent.includes('not found'));
  check(await page.evaluate(() => state.currentPerformer === null && state.videos.length === 0), '404 retained performer');
  results.push('stale search, keyboard cards and performer 404');

  await page.evaluate(() => { videoScrollObserver.disconnect(); openPerformer('Alpha'); });
  await page.locator('#videosGrid .video-card').first().waitFor();
  failAppend = true;
  await page.evaluate(() => { state.videoPage = 1; return loadVideos(2, true); });
  check(await page.evaluate(() => state.videoPage === 1 && state.videos.length === 2), 'Append failure advanced page');
  failAppend = false;
  delayedFavorite = true;
  await page.locator('#videosGrid .video-card').first().click();
  await page.locator('#videoModal').waitFor({ state: 'visible' });
  await page.locator('#favGlobalVideo').click();
  await page.waitForFunction(() => document.getElementById('favGlobalVideo').getAttribute('aria-pressed') === 'true');
  check(calls.some(c => c.path === '/api/media/11/favorite' && c.method === 'POST'), 'Global favorite used personal endpoint');
  await page.locator('#commentsToggle').click();
  await page.locator('#commentInput').fill('');
  await page.locator('#commentInput').pressSequentially('f m p d 123 . ,');
  check(await page.locator('#commentInput').inputValue() === 'f m p d 123 . ,', 'Player intercepted typing');
  await page.evaluate(() => {
    const el = document.createElement('div'); el.contentEditable = 'true'; el.id = 'editableFixture';
    document.querySelector('.vp-comments').appendChild(el); el.focus();
  });
  await page.keyboard.type('f m 12');
  check(await page.locator('#editableFixture').textContent() === 'f m 12', 'Contenteditable intercepted');
  failComments = true;
  await page.evaluate(() => loadComments(activeVideoId));
  check(await page.locator('#commentsError').isVisible(), 'Comments error absent');
  await page.locator('#videoNext').click();
  await page.waitForFunction(() => activeVideoId === 12);
  await page.waitForTimeout(500);
  check(!(await page.locator('#favCurrentVideo').getAttribute('class')).includes('active'), 'Stale personal favorite');
  results.push('infinite-scroll rollback, editable shortcuts, comments errors and social guards');

  await page.evaluate(() => { document.getElementById('videoPlayer').currentTime = 42; });
  await page.locator('#vpRelatedGrid .related-card').first().click();
  await page.waitForFunction(() => activeVideoId === 99);
  check(await page.evaluate(() => resumeMap[12] === 42 && !resumeMap[99]), 'Related navigation saved wrong resume ID');
  await page.evaluate(() => { state.videos.push({id: 100, type: 'video', filename: 'Next'}); document.getElementById('videoPlayer').dispatchEvent(new Event('ended')); });
  await page.locator('#closeVideo').click();
  await page.waitForTimeout(1400);
  check(await page.locator('#videoModal').isHidden(), 'Autoplay reopened closed modal');
  results.push('related playlist/resume identity and cancelled autoplay');

  await page.locator('#userMenuToggle').click();
  await page.locator('#ddFavorites').click();
  await page.locator('#myFavContent .video-card').first().waitFor();
  check((await page.locator('#favTabMy').getAttribute('class')).includes('active'), 'Personal tab not selected');
  check(await page.evaluate(() => state.videos.map(v => v.id).join(',') === '11,12'), 'Personal playlist missing');
  await page.locator('#favPagination [data-page="2"]').first().click();
  check(calls.some(c => c.path === '/social/favorites' && c.search.includes('page=2')), 'Personal pagination missing');
  await page.evaluate(() => apiFetch('/api/expire', 1).catch(() => {}));
  await page.locator('#authModal').waitFor({ state: 'visible' });
  check(await page.evaluate(() => state.videos.length === 0 && Object.keys(resumeMap).length === 0), 'Session data retained');
  await page.locator('#loginEmail').fill('fixture@example.invalid');
  await page.locator('#loginPassword').fill('not-a-real-password');
  await page.locator('#loginForm button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('userUname').textContent === 'Reconnected');
  await page.locator('#favContent .video-card').first().waitFor();
  results.push('personal menu/pagination and expired-session reset/reconnection reload');

  await page.locator('#btnManage').click();
  scanConflict = true;
  const progressBefore = calls.filter(c => c.path === '/api/scan/progress').length;
  await page.evaluate(() => launchScan('all'));
  check(calls.filter(c => c.path === '/api/scan/progress').length === progressBefore + 1, 'Scan conflict did not verify progress');
  check(await page.evaluate(() => state.scanInterval === null), 'Maintenance conflict started scan polling');
  check((await page.locator('#toast').textContent()).includes('Maintenance busy'), 'Maintenance conflict reported stale scan success');
  check(await page.locator('#scanBanner').isHidden(), 'Maintenance conflict kept a fake scan banner');
  scanConflict = false;
  await page.locator('#btnScanAll').click();
  await page.locator('#closeManage').click();
  const before = calls.filter(c => c.path === '/api/scan/progress').length;
  await page.waitForTimeout(1000);
  check(calls.filter(c => c.path === '/api/scan/progress').length > before, 'Closing modal stopped polling');
  await page.locator('#scanBannerCancel').click();
  await page.locator('#scanBanner').waitFor({ state: 'hidden' });
  check(await page.locator('#scanBannerCancel').isEnabled(), 'Cancel button not reset');
  results.push('scan maintenance conflict verification, polling independent of modal and cancellation reset');

  await page.setViewportSize({ width: 390, height: 844 });
  if (!(await page.locator('html').getAttribute('class') || '').includes('light-theme')) await page.locator('#btnTheme').click();
  await page.locator('#userMenuToggle').click();
  await page.locator('#ddProfile').click();
  await page.locator('#profileModal').waitFor({ state: 'visible' });
  check(await page.evaluate(() => { const el = document.querySelector('.profile-modal-inner'); return el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'; }), 'Mobile profile cannot scroll');
  await page.locator('#changePwBtn').scrollIntoViewIfNeeded();
  await page.locator('#changePwBtn').focus();
  await page.keyboard.press('Tab');
  check(await page.evaluate(() => document.getElementById('profileModal').contains(document.activeElement)), 'Focus escaped dialog');
  await page.keyboard.press('Escape');
  check(await page.locator('#profileModal').isHidden(), 'Escape did not close profile');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile horizontal overflow');
  results.push('mobile light theme, profile scroll, focus trap and Escape');

  await page.goto(origin + '/admin.html');
  await page.waitForFunction(() => document.getElementById('adminUser').textContent.length > 0);
  await page.locator('[data-tab="tools"]').click();
  await page.locator('#dupScanBtn').click();
  await page.waitForFunction(() => document.getElementById('dupLabel').textContent.includes('Fixture failure'));
  check(!(await page.locator('#dupLabel').textContent()).includes('Aucun doublon'), 'SSE error turned into success');
  dupMode = 'empty';
  await page.locator('#dupScanBtn').click();
  await page.waitForFunction(() => document.getElementById('dupLabel').textContent.includes('Aucun doublon'));
  dupMode = 'pending';
  await page.locator('#dupScanBtn').click();
  await page.locator('#dupCancelBtn').click();
  await page.waitForFunction(() => !document.getElementById('dupScanBtn').disabled);
  check(!(await page.locator('#dupLabel').textContent()).includes('Aucun doublon'), 'Cancelled request reported success');
  await page.locator('[data-tab="settings"]').click();
  await page.waitForFunction(() => document.getElementById('smtpHost').value === 'smtp.fixture.invalid');
  failSettings = true;
  const failedPut = page.waitForResponse(response => response.url().endsWith('/admin/settings') && response.request().method() === 'PUT');
  await page.locator('#saveRegBtn').click();
  check((await failedPut).status() === 500, 'Expected failed settings PUT');
  await page.waitForFunction(() => document.getElementById('smtpTestResult').textContent.includes('Settings PUT failed'));
  check((await page.locator('#smtpTestResult').getAttribute('class')).includes('alert-error'), 'Non2xx settings false success');
  failSettings = false;
  for (const [id, value] of [['smtpHost', 'new.fixture.invalid'], ['smtpPort', '465'], ['smtpUser', 'new-fixture'], ['smtpSecure', true]]) {
    // Restore a secret before each connection-field change, then submit an empty password.
    await page.locator('#smtpPass').fill('fixture-only-secret');
    await page.locator('#saveSmtpBtn').click();
    await page.waitForFunction(() => document.getElementById('smtpTestResult').textContent.includes('secret configuré'));
    if (id === 'smtpSecure') await page.locator('#' + id).check();
    else await page.locator('#' + id).fill(value);
    const getCount = calls.filter(c => c.path === '/admin/settings' && c.method === 'GET').length;
    await page.locator('#saveSmtpBtn').click();
    await page.waitForFunction(() => document.getElementById('smtpTestResult').textContent.includes('sauvegardé sans secret'));
    check(calls.filter(c => c.path === '/admin/settings' && c.method === 'GET').length > getCount, 'SMTP save did not reload settings');
    check(await page.locator('#smtpPass').getAttribute('placeholder') === 'Aucun secret configuré', 'SMTP UI claimed erased secret was retained');
    check(settings.smtp_pass === '', 'Fixture failed to erase secret after ' + id);
  }
  results.push('settings GET succeeds, rejected PUT is awaited, SMTP secret state reloaded for host/port/user/TLS changes');
  await page.locator('[data-tab="tools"]').click();
  await page.locator('#mbLoadBtn').click();
  await page.locator('.mb-card-cb').check();
  await page.evaluate(() => { window.confirm = () => true; });
  await page.locator('#mbDeleteBtn').click();
  await page.waitForFunction(() => document.getElementById('mbLabel').textContent.includes('Deletion failed'));
  check(await page.locator('.mb-card').count() === 1, 'Failed deletion removed card');
  deleteError = { error: 'Commit unknown', deleted: null, recovery_required: true, operation_id: 'fixture-unknown' };
  await page.locator('#mbDeleteBtn').click();
  await page.waitForFunction(() => document.getElementById('mbLabel').textContent.includes('fixture-unknown'));
  check((await page.locator('#mbLabel').textContent()).includes('état incertain'), 'Unknown commit presented as definite zero');
  check(await page.locator('.mb-card').count() === 1, 'Uncertain deletion removed card');
  deleteError = { error: 'Journal failed after commit', deleted: 1, recovery_required: true, operation_id: 'fixture-committed' };
  await page.locator('#mbDeleteBtn').click();
  await page.waitForFunction(() => document.getElementById('mbLabel').textContent.includes('fixture-committed'));
  check((await page.locator('#mbLabel').textContent()).includes('1 / 1 suppression'), 'Committed deletion was not counted on HTTP error');
  check(await page.locator('.mb-card').count() === 0, 'Confirmed committed deletion kept card');
  await page.locator('#mbLoadBtn').click();
  await page.locator('.mb-card-cb').check();
  failDelete = false;
  await page.locator('#mbDeleteBtn').click();
  await page.waitForFunction(() => document.querySelectorAll('.mb-card').length === 0);
  const deletion = calls.find(c => c.path === '/admin/media/11' && c.method === 'DELETE');
  check(JSON.parse(deletion.body).deleteFile === true && JSON.parse(deletion.body).dry_run === false, 'Destructive booleans not explicit');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Admin mobile overflow');
  results.push('mobile admin navigation, SSE failure/success/abort-before-headers, non2xx settings and exact manual delete failure/success');
  check(errors.length === 0, 'Browser exceptions: ' + errors.join('; '));
  return { results, pageErrors: errors, requests: calls.length, viewport: await page.viewportSize() };
};
