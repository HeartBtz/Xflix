/* ═══════════════════════════════════════════════════════════
   XFlix Admin Panel — JS v2.0
   Redesigned with encoding support
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Auth ─────────────────────────────────────────────── */
  const token = () => localStorage.getItem('xflix_token');

  async function apiFetch(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401 || res.status === 403) {
      alert('Accès refusé. Veuillez vous connecter en tant qu\'admin.');
      window.location.href = '/';
      throw new Error('Unauthorized');
    }
    return res;
  }

  /* ── Bootstrap ────────────────────────────────────────── */
  async function boot() {
    if (!token()) { window.location.href = '/'; return; }
    const res = await fetch('/auth/me', { headers: { Authorization: `Bearer ${token()}` } });
    if (!res.ok) { window.location.href = '/'; return; }
    const user = await res.json();
    if (user.role !== 'admin') { window.location.href = '/'; return; }
    document.getElementById('adminUser').textContent = `${user.username}`;
    loadDashboard();
  }

  document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('xflix_token');
    window.location.href = '/';
  });

  /* ── Tabs ─────────────────────────────────────────────── */
  const tabBtns = document.querySelectorAll('.sidenav-item');
  const tabs    = document.querySelectorAll('.admin-tab');

  tabBtns.forEach(btn => btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    tabs.forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'dashboard') loadDashboard();
    if (btn.dataset.tab === 'users') loadUsers();
    if (btn.dataset.tab === 'settings') loadSettings();
    if (btn.dataset.tab === 'encode') initEncodeTab();
    if (btn.dataset.tab === 'tools') loadMbPerformers();
  }));

  /* ═══════════════════════════════════════════════════════
     DASHBOARD
     ═══════════════════════════════════════════════════════ */
  async function loadDashboard() {
    try {
      const res = await apiFetch('/admin/stats');
      const data = await res.json();
      document.getElementById('st-users').textContent    = data.users    ?? '?';
      document.getElementById('st-media').textContent    = data.media    ?? '?';
      document.getElementById('st-comments').textContent = data.comments ?? '?';
      document.getElementById('st-reactions').textContent= data.reactions?? '?';
    } catch {}
  }

  /* ═══════════════════════════════════════════════════════
     USERS
     ═══════════════════════════════════════════════════════ */
  let userPage = 1;
  const userSearch = document.getElementById('userSearch');

  userSearch.addEventListener('input', debounce(() => { userPage = 1; loadUsers(); }, 300));

  async function loadUsers() {
    const search = userSearch.value;
    const url = `/admin/users?page=${userPage}&limit=25${search ? '&search=' + encodeURIComponent(search) : ''}`;
    const res = await apiFetch(url);
    const { data, total, limit } = await res.json();
    const tbody = document.getElementById('usersBody');
    tbody.innerHTML = data.map(u => `
      <tr>
        <td>${u.id}</td>
        <td>${esc(u.username)}</td>
        <td>${esc(u.email)}</td>
        <td><span class="badge badge-${u.role}">${u.role}</span></td>
        <td>${u.last_login ? fmtDate(u.last_login) : '—'}</td>
        <td>${fmtDate(u.created_at)}</td>
        <td>
          <button class="btn btn-sm" onclick="toggleRole(${u.id}, '${u.role}')">
            ${u.role === 'admin' ? '⬇ Membre' : '⬆ Admin'}
          </button>
          <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id}, '${esc(u.username)}')">✕</button>
        </td>
      </tr>
    `).join('');

    const pages = Math.ceil(total / limit);
    const pag = document.getElementById('usersPagination');
    pag.innerHTML = '';
    for (let p = 1; p <= pages; p++) {
      const btn = document.createElement('button');
      btn.className = 'page-btn' + (p === userPage ? ' active' : '');
      btn.textContent = p;
      btn.addEventListener('click', () => { userPage = p; loadUsers(); });
      pag.appendChild(btn);
    }
  }

  window.toggleRole = async (id, current) => {
    const newRole = current === 'admin' ? 'member' : 'admin';
    if (!confirm(`Changer le rôle de cet utilisateur en "${newRole}" ?`)) return;
    await apiFetch(`/admin/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role: newRole }) });
    loadUsers();
  };

  window.deleteUser = async (id, name) => {
    if (!confirm(`Supprimer l'utilisateur "${name}" ? Les commentaires et réactions seront également supprimés.`)) return;
    await apiFetch(`/admin/users/${id}`, { method: 'DELETE' });
    loadUsers();
  };

  /* ═══════════════════════════════════════════════════════
     MEDIA — SCAN
     ═══════════════════════════════════════════════════════ */
  const scanBtn       = document.getElementById('scanBtn');
  const scanCancelBtn = document.getElementById('scanCancelBtn');
  const scanLog       = document.getElementById('scanLog');
  let scanReader = null;

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    scanCancelBtn.classList.remove('hidden');
    scanLog.classList.remove('hidden');
    scanLog.innerHTML = '<span class="log-info">Démarrage du scan…</span>\n';

    try {
      const res = await apiFetch('/admin/scan', { method: 'POST' });
      scanReader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await scanReader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const d = JSON.parse(line.slice(5));
            const text = formatScanLine(d);
            if (text) logAppend(scanLog, d.status === 'error' ? 'log-err' : 'log-info', text);
          } catch {}
        }
      }
    } catch(e) { logAppend(scanLog, 'log-err', '❌ ' + e.message); }
    scanReader = null;
    scanBtn.disabled = false;
    scanCancelBtn.classList.add('hidden');
  });

  scanCancelBtn.addEventListener('click', async () => {
    scanCancelBtn.disabled = true;
    if (scanReader) try { await scanReader.cancel(); } catch(_) {}
    await apiFetch('/admin/scan/cancel', { method: 'POST' }).catch(() => {});
    logAppend(scanLog, 'log-err', '⏹ Scan annulé');
    scanCancelBtn.disabled = false;
    scanCancelBtn.classList.add('hidden');
    scanBtn.disabled = false;
  });

  function formatScanLine(d) {
    if (d.status === 'progress') {
      const performer = d.currentPerformer ? ` [${d.currentPerformer}]` : '';
      const skipped = d.skipped ? ` (${d.skipped} ignorés)` : '';
      return `${d.done ?? 0}/${d.total ?? '?'} fichiers indexés${skipped}${performer}`;
    }
    if (d.status === 'done') {
      const t = d.total ?? d.done ?? 0;
      const sk = d.skipped ? `, ${d.skipped} ignorés` : '';
      const err = d.errors ? `, ${d.errors} erreur(s)` : '';
      return `✅ Scan terminé — ${t} nouveaux, ${sk.replace(', ', '')}${err}`;
    }
    if (d.status === 'error') return `❌ Erreur: ${d.error}`;
    if (d.status === 'started') return '⏳ Démarrage du scan...';
    return null;
  }

  /* ── Batch Thumbs ── */
  const batchThumbBtn       = document.getElementById('batchThumbBtn');
  const batchThumbCancelBtn = document.getElementById('batchThumbCancelBtn');
  const thumbProgress       = document.getElementById('thumbProgress');
  const thumbFill           = document.getElementById('thumbFill');
  const thumbLabel          = document.getElementById('thumbLabel');
  let thumbReader = null;

  batchThumbBtn.addEventListener('click', async () => {
    batchThumbBtn.disabled = true;
    batchThumbCancelBtn.classList.remove('hidden');
    thumbProgress.classList.remove('hidden');
    thumbFill.style.width = '0%';
    thumbLabel.textContent = 'Démarrage…';

    try {
      const res = await apiFetch('/admin/batch-thumbs', { method: 'POST' });
      thumbReader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await thumbReader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const d = JSON.parse(line.slice(5));
            if (typeof d.total === 'number' && d.total > 0) {
              const pct = Math.round((d.done / d.total) * 100);
              thumbFill.style.width = pct + '%';
              thumbLabel.textContent = `${d.done} / ${d.total} (${pct}%)`;
            } else if (d.total === 0) {
              thumbLabel.textContent = 'Aucune miniature manquante';
            }
            if (d.status === 'done') thumbLabel.textContent += ' ✅';
            if (d.status === 'error') thumbLabel.textContent = '❌ ' + d.error;
          } catch {}
        }
      }
    } catch(e) { thumbLabel.textContent = '❌ ' + e.message; }
    thumbReader = null;
    batchThumbBtn.disabled = false;
    batchThumbCancelBtn.classList.add('hidden');
  });

  batchThumbCancelBtn.addEventListener('click', async () => {
    batchThumbCancelBtn.disabled = true;
    if (thumbReader) try { await thumbReader.cancel(); } catch(_) {}
    thumbLabel.textContent += ' (annulé)';
    batchThumbCancelBtn.disabled = false;
    batchThumbCancelBtn.classList.add('hidden');
    batchThumbBtn.disabled = false;
  });

  /* ═══════════════════════════════════════════════════════
     MEDIA — VIDER BDD
     ═══════════════════════════════════════════════════════ */
  document.getElementById('clearDbBtn').addEventListener('click', async () => {
    if (!confirm('⚠️ Vider la base de données ?\n\nTous les médias et performers indexés seront supprimés.\nLes fichiers sur disque ne seront pas touchés.')) return;
    try {
      const res = await apiFetch('/api/clear', { method: 'POST' });
      const data = await res.json();
      alert('✅ ' + (data.message || 'Base de données vidée'));
      loadDashboard();
    } catch(e) { alert('Erreur : ' + e.message); }
  });

  /* ═══════════════════════════════════════════════════════
     TOOLS — DUPLICATES
     ═══════════════════════════════════════════════════════ */
  const dupScanBtn   = document.getElementById('dupScanBtn');
  const dupCancelBtn = document.getElementById('dupCancelBtn');
  const dupProgress  = document.getElementById('dupProgress');
  const dupFill      = document.getElementById('dupFill');
  const dupLabel     = document.getElementById('dupLabel');
  const dupResults   = document.getElementById('dupResults');
  let dupReader = null;
  let dupGroups = [];

  dupScanBtn.addEventListener('click', async () => {
    dupScanBtn.disabled = true;
    dupCancelBtn.classList.remove('hidden');
    dupProgress.classList.remove('hidden');
    dupFill.style.width = '0%';
    dupResults.classList.add('hidden');
    dupResults.innerHTML = '';
    dupGroups = [];

    let finalGroups = [], finalCount = 0;
    let typeLabel = '';

    try {
      const mediaType = document.querySelector('input[name="dupType"]:checked')?.value || 'all';
      typeLabel = mediaType === 'video' ? 'Vidéos' : mediaType === 'photo' ? 'Photos' : 'Tous médias';
      dupLabel.textContent = `Démarrage — ${typeLabel}…`;
      const res = await apiFetch('/admin/duplicates/scan', {
        method: 'POST',
        body: JSON.stringify({ mediaType }),
      });
      dupReader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await dupReader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const d = JSON.parse(line.slice(5));
            if (d.status === 'phase') {
              dupLabel.textContent = d.message;
              dupFill.style.width = d.phase === 'hashing' ? '50%' : d.phase === 'sizing' ? '20%' : '5%';
            } else if (d.status === 'progress' && d.phase === 'hashing') {
              const pct = 50 + Math.round((d.done / d.total) * 50);
              dupFill.style.width = pct + '%';
              dupLabel.textContent = `Hash des groupes suspects… ${d.done} / ${d.total}`;
            } else if (d.status === 'done') {
              dupFill.style.width = '100%';
              finalGroups = d.groups || [];
              finalCount  = d.count  || 0;
            } else if (d.status === 'error') {
              dupLabel.textContent = '❌ ' + d.error;
            }
          } catch {}
        }
      }
    } catch(e) {
      if (e.name !== 'AbortError') dupLabel.textContent = '❌ ' + e.message;
    }

    dupReader = null;
    dupScanBtn.disabled = false;
    dupCancelBtn.classList.add('hidden');

    if (finalGroups.length === 0) {
      dupLabel.textContent = `✅ Aucun doublon détecté (${typeLabel}).`;
      return;
    }

    dupLabel.textContent = `✅ ${finalGroups.length} groupe(s) — ${finalCount} fichier(s) (${typeLabel})`;
    dupGroups = finalGroups;
    renderDupGroups(finalGroups);
  });

  dupCancelBtn.addEventListener('click', async () => {
    dupCancelBtn.disabled = true;
    if (dupReader) try { await dupReader.cancel(); } catch(_) {}
    dupLabel.textContent += ' (annulé)';
    dupCancelBtn.disabled = false;
    dupCancelBtn.classList.add('hidden');
    dupScanBtn.disabled = false;
  });

  function renderDupGroups(groups) {
    dupResults.classList.remove('hidden');
    dupResults.innerHTML = '';

    const toolbar = document.createElement('div');
    toolbar.className = 'dup-toolbar';
    toolbar.innerHTML = `
      <span style="font-size:12px;font-weight:600">Stratégie :</span>
      <select id="dupStrategy" class="input">
        <option value="keep-first">Garder le premier</option>
        <option value="keep-last">Garder le dernier</option>
        <option value="keep-largest">Garder le plus grand</option>
        <option value="keep-smallest">Garder le plus petit</option>
      </select>
      <button class="btn btn-sm" id="applyStrategyAllBtn">✅ Appliquer à tous</button>
      <button class="btn btn-sm" id="unselectAllBtn">✗ Tout décocher</button>
      <span class="dup-toolbar-sep"></span>
      <label class="checkbox-label">
        <input type="checkbox" id="deletePhysical" checked>
        Supprimer fichiers physiques
      </label>
      <button class="btn btn-sm btn-danger" id="deleteSelectedBtn" disabled>🗑 Supprimer (0)</button>
    `;
    dupResults.appendChild(toolbar);

    groups.forEach((g, gi) => {
      const groupDiv = document.createElement('div');
      groupDiv.className = 'dup-group';
      groupDiv.dataset.gi = gi;

      const header = document.createElement('div');
      header.className = 'dup-group-header';
      header.innerHTML = `
        <input type="checkbox" class="dup-group-cb" data-gi="${gi}">
        <span class="dup-group-title">Groupe ${gi + 1} — ${g.length} fichiers</span>
        <button class="btn btn-sm" data-gi="${gi}" style="font-size:10px" onclick="applyStrategyGroup(${gi})">Appliquer</button>
      `;
      groupDiv.appendChild(header);

      g.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'dup-item';
        row.id = `dup-item-${item.id}`;
        row.dataset.id = item.id; row.dataset.gi = gi; row.dataset.idx = idx; row.dataset.size = item.size || 0;
        row.innerHTML = `
          <input type="checkbox" class="dup-cb" data-id="${item.id}" data-gi="${gi}">
          <img class="dup-thumb" src="/thumb/${item.id}" onerror="this.style.display='none'" loading="lazy">
          <div class="dup-info">
            <div class="dup-name">${esc(item.file_path.split('/').pop())}</div>
            <div class="dup-path">${esc(item.file_path)} — ${esc(item.performer_name)}</div>
          </div>
          <span class="dup-size">${fmtSize(item.size)}</span>
          <button class="btn btn-sm btn-danger" onclick="deleteSingleDup(${item.id})" title="Supprimer">🗑</button>
        `;
        groupDiv.appendChild(row);
      });

      dupResults.appendChild(groupDiv);
    });

    document.getElementById('applyStrategyAllBtn').addEventListener('click', () => {
      const strategy = document.getElementById('dupStrategy').value;
      groups.forEach((_, gi) => applyStrategyToGroup(gi, strategy));
      updateDelBtn();
    });

    document.getElementById('unselectAllBtn').addEventListener('click', () => {
      dupResults.querySelectorAll('.dup-cb, .dup-group-cb').forEach(cb => { cb.checked = false; });
      dupResults.querySelectorAll('.dup-item').forEach(el => el.classList.remove('dup-selected'));
      updateDelBtn();
    });

    dupResults.addEventListener('change', e => {
      if (e.target.classList.contains('dup-cb')) {
        const gi = e.target.dataset.gi;
        const groupCbs = [...dupResults.querySelectorAll(`.dup-cb[data-gi="${gi}"]`)];
        const groupHeaderCb = dupResults.querySelector(`.dup-group-cb[data-gi="${gi}"]`);
        const checkedCount = groupCbs.filter(c => c.checked).length;
        groupHeaderCb.indeterminate = checkedCount > 0 && checkedCount < groupCbs.length;
        groupHeaderCb.checked = checkedCount === groupCbs.length;
        e.target.closest('.dup-item').classList.toggle('dup-selected', e.target.checked);
        updateDelBtn();
      }
      if (e.target.classList.contains('dup-group-cb')) {
        const gi = e.target.dataset.gi;
        dupResults.querySelectorAll(`.dup-cb[data-gi="${gi}"]`).forEach(cb => {
          cb.checked = e.target.checked;
          cb.closest('.dup-item').classList.toggle('dup-selected', e.target.checked);
        });
        e.target.indeterminate = false;
        updateDelBtn();
      }
    });

    document.getElementById('deleteSelectedBtn').addEventListener('click', deleteSelected);
  }

  function updateDelBtn() {
    const count = dupResults.querySelectorAll('.dup-cb:checked').length;
    const btn = document.getElementById('deleteSelectedBtn');
    if (!btn) return;
    btn.disabled = count === 0;
    btn.textContent = `🗑 Supprimer (${count})`;
  }

  window.applyStrategyGroup = (gi) => {
    const strategy = document.getElementById('dupStrategy')?.value || 'keep-first';
    applyStrategyToGroup(gi, strategy);
    updateDelBtn();
  };

  function applyStrategyToGroup(gi, strategy) {
    const items = [...dupResults.querySelectorAll(`.dup-item[data-gi="${gi}"]`)];
    if (!items.length) return;
    let keepIdx = 0;
    if (strategy === 'keep-last') keepIdx = items.length - 1;
    else if (strategy === 'keep-largest') keepIdx = items.reduce((best, el, i) => Number(el.dataset.size) > Number(items[best].dataset.size) ? i : best, 0);
    else if (strategy === 'keep-smallest') keepIdx = items.reduce((best, el, i) => Number(el.dataset.size) < Number(items[best].dataset.size) ? i : best, 0);
    items.forEach((el, i) => {
      const cb = el.querySelector('.dup-cb');
      const checked = i !== keepIdx;
      cb.checked = checked;
      el.classList.toggle('dup-selected', checked);
    });
    const ghCb = dupResults.querySelector(`.dup-group-cb[data-gi="${gi}"]`);
    if (ghCb) { ghCb.indeterminate = true; ghCb.checked = false; }
  }

  async function deleteSelected() {
    const checked = [...dupResults.querySelectorAll('.dup-cb:checked')];
    if (!checked.length) return;
    const ids = checked.map(cb => Number(cb.dataset.id));
    const deleteFile = document.getElementById('deletePhysical')?.checked ?? true;
    const label = deleteFile
      ? `Supprimer ${ids.length} fichier(s) base + disque ?`
      : `Supprimer ${ids.length} fichier(s) de la base uniquement ?`;
    if (!confirm(label)) return;

    const btn = document.getElementById('deleteSelectedBtn');
    btn.disabled = true;
    dupFill.style.width = '0%';
    dupLabel.textContent = `⏳ Suppression 0 / ${ids.length}…`;

    let deleted = 0;
    const errors = [];

    try {
      const res = await apiFetch('/admin/duplicates/delete-bulk', {
        method: 'POST', body: JSON.stringify({ ids, deleteFile }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const d = JSON.parse(line.slice(5));
            if (d.status === 'progress') {
              const pct = Math.round((d.done / d.total) * 100);
              dupFill.style.width = pct + '%';
              dupLabel.textContent = `⏳ Suppression ${d.done} / ${d.total}…`;
              if (!d.skipped && !d.error) {
                const el = document.getElementById(`dup-item-${d.id}`);
                if (el) { const g = el.closest('.dup-group'); el.remove(); if (g && !g.querySelector('.dup-item')) g.remove(); }
              }
              if (d.error) errors.push(d);
            } else if (d.status === 'done') {
              deleted = d.deleted;
              if (d.errors) errors.push(...d.errors);
            } else if (d.status === 'error') {
              errors.push({ error: d.error });
            }
          } catch {}
        }
      }
    } catch(e) {
      dupLabel.textContent = '❌ ' + e.message;
      btn.disabled = false; updateDelBtn(); return;
    }
    dupFill.style.width = '100%';
    dupLabel.textContent = `✅ ${deleted} supprimé(s)${errors.length ? ` — ⚠️ ${errors.length} erreur(s)` : ''}`;
    updateDelBtn();
  }

  window.deleteSingleDup = async (id) => {
    if (!confirm('Supprimer ce fichier de la base et du disque ?')) return;
    const res = await apiFetch(`/admin/duplicates/${id}`, { method: 'DELETE' });
    if (res.ok) {
      const el = document.getElementById(`dup-item-${id}`);
      if (el) { const g = el.closest('.dup-group'); el.remove(); if (g && !g.querySelector('.dup-item')) g.remove(); }
      updateDelBtn();
    }
  };

  /* ═══════════════════════════════════════════════════════
     TOOLS — MEDIA BROWSER
     ═══════════════════════════════════════════════════════ */
  const mbPerformerSel = document.getElementById('mbPerformer');
  const mbTypeEl    = document.getElementById('mbType');
  const mbSearchEl  = document.getElementById('mbSearch');
  const mbLoadBtn   = document.getElementById('mbLoadBtn');
  const mbToolbar   = document.getElementById('mbToolbar');
  const mbGrid      = document.getElementById('mbGrid');
  const mbPag       = document.getElementById('mbPagination');
  const mbSelCount  = document.getElementById('mbSelCount');
  const mbDeleteBtn = document.getElementById('mbDeleteBtn');
  const mbProgress  = document.getElementById('mbProgress');
  const mbFill      = document.getElementById('mbFill');
  const mbLabel     = document.getElementById('mbLabel');
  let mbPage = 1;
  const MB_LIMIT = 80;

  async function loadMbPerformers() {
    if (mbPerformerSel.options.length > 1) return;
    try {
      const res = await apiFetch('/api/performers?limit=200&sort=name&order=asc');
      const { data } = await res.json();
      data.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id; opt.textContent = p.name;
        mbPerformerSel.appendChild(opt);
      });
    } catch {}
  }

  async function loadMbMedia() {
    mbLoadBtn.disabled = true;
    mbGrid.innerHTML = ''; mbGrid.classList.remove('hidden');
    mbToolbar.classList.remove('hidden'); mbPag.innerHTML = '';

    const params = new URLSearchParams({
      page: mbPage, limit: MB_LIMIT,
      ...(mbPerformerSel.value ? { performer_id: mbPerformerSel.value } : {}),
      ...(mbTypeEl.value ? { type: mbTypeEl.value } : {}),
      ...(mbSearchEl.value.trim() ? { q: mbSearchEl.value.trim() } : {}),
    });

    try {
      const res = await apiFetch(`/admin/media?${params}`);
      const { data, total } = await res.json();
      if (!data.length) {
        mbGrid.innerHTML = '<div class="mb-empty">Aucun média trouvé.</div>';
        mbLoadBtn.disabled = false; updateMbSel(); return;
      }
      data.forEach(item => {
        const card = document.createElement('div');
        card.className = 'mb-card'; card.dataset.id = item.id;
        card.innerHTML = `
          <input class="mb-card-cb" type="checkbox" data-id="${item.id}">
          <img src="/thumb/${item.id}" loading="lazy" onerror="this.style.opacity='.3'">
          ${item.size ? `<span class="mb-card-size">${fmtSize(item.size)}</span>` : ''}
          <div class="mb-card-info">
            <div class="mb-card-name" title="${esc(item.file_path)}">${esc(item.file_path.split('/').pop())}</div>
            <div class="mb-card-meta">${esc(item.performer_name)}</div>
          </div>
        `;
        card.addEventListener('click', e => {
          if (e.target.classList.contains('mb-card-cb')) return;
          const cb = card.querySelector('.mb-card-cb');
          cb.checked = !cb.checked; card.classList.toggle('mb-selected', cb.checked); updateMbSel();
        });
        card.querySelector('.mb-card-cb').addEventListener('change', e => {
          card.classList.toggle('mb-selected', e.target.checked); updateMbSel();
        });
        mbGrid.appendChild(card);
      });

      const pages = Math.ceil(total / MB_LIMIT);
      if (pages > 1) {
        const info = document.createElement('span');
        info.style.cssText = 'font-size:11px;color:var(--a-text-muted);margin-right:8px';
        info.textContent = `${total} résultat(s) — page ${mbPage}/${pages}`;
        mbPag.appendChild(info);
        const prev = document.createElement('button');
        prev.className = 'page-btn'; prev.textContent = '‹'; prev.disabled = mbPage <= 1;
        prev.addEventListener('click', () => { mbPage--; loadMbMedia(); });
        mbPag.appendChild(prev);
        const next = document.createElement('button');
        next.className = 'page-btn'; next.textContent = '›'; next.disabled = mbPage >= pages;
        next.addEventListener('click', () => { mbPage++; loadMbMedia(); });
        mbPag.appendChild(next);
      }
    } catch(e) { mbGrid.innerHTML = `<div class="mb-empty">❌ ${esc(e.message)}</div>`; }
    mbLoadBtn.disabled = false; updateMbSel();
  }

  function updateMbSel() {
    const total = mbGrid.querySelectorAll('.mb-card-cb').length;
    const checked = mbGrid.querySelectorAll('.mb-card-cb:checked').length;
    mbSelCount.textContent = `${checked} / ${total}`;
    mbDeleteBtn.disabled = checked === 0;
    mbDeleteBtn.textContent = `🗑 Supprimer${checked ? ` (${checked})` : ''}`;
  }

  mbLoadBtn.addEventListener('click', () => { mbPage = 1; loadMbMedia(); });
  mbSearchEl.addEventListener('keydown', e => { if (e.key === 'Enter') { mbPage = 1; loadMbMedia(); } });

  document.getElementById('mbSelectAllBtn').addEventListener('click', () => {
    mbGrid.querySelectorAll('.mb-card-cb').forEach(cb => { cb.checked = true; cb.closest('.mb-card').classList.add('mb-selected'); });
    updateMbSel();
  });
  document.getElementById('mbUnselectBtn').addEventListener('click', () => {
    mbGrid.querySelectorAll('.mb-card-cb').forEach(cb => { cb.checked = false; cb.closest('.mb-card').classList.remove('mb-selected'); });
    updateMbSel();
  });

  mbDeleteBtn.addEventListener('click', async () => {
    const checked = [...mbGrid.querySelectorAll('.mb-card-cb:checked')];
    if (!checked.length) return;
    const ids = checked.map(cb => Number(cb.dataset.id));
    if (!confirm(`Supprimer ${ids.length} fichier(s) du disque et de la base ?`)) return;
    mbDeleteBtn.disabled = true;
    mbProgress.classList.remove('hidden');
    mbFill.style.width = '0%'; mbLabel.textContent = `⏳ 0 / ${ids.length}…`;

    try {
      const res = await apiFetch('/admin/duplicates/delete-bulk', {
        method: 'POST', body: JSON.stringify({ ids, deleteFile: true }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', deleted = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const d = JSON.parse(line.slice(5));
            if (d.status === 'progress') {
              mbFill.style.width = Math.round((d.done / d.total) * 100) + '%';
              mbLabel.textContent = `⏳ ${d.done} / ${d.total}…`;
              if (!d.error && !d.skipped) {
                const card = mbGrid.querySelector(`.mb-card[data-id="${d.id}"]`);
                if (card) card.remove();
              }
            } else if (d.status === 'done') deleted = d.deleted;
          } catch {}
        }
      }
      mbFill.style.width = '100%';
      mbLabel.textContent = `✅ ${deleted} supprimé(s)`;
    } catch(e) { mbLabel.textContent = '❌ ' + e.message; }
    updateMbSel();
  });

  /* ── Clean Media ── */
  const cleanBtn        = document.getElementById('cleanBtn');
  const cleanCancelBtn  = document.getElementById('cleanCancelBtn');
  const cleanLog        = document.getElementById('cleanLog');
  const cleanDryRun     = document.getElementById('cleanDryRun');
  const cleanVerbose    = document.getElementById('cleanVerbose');
  const cleanProgress   = document.getElementById('cleanProgress');
  const cleanFill       = document.getElementById('cleanFill');
  const cleanPhaseLabel = document.getElementById('cleanPhaseLabel');
  let cleanReader = null;

  function cleanSetProgress(pct, label) {
    cleanProgress.classList.remove('hidden');
    cleanFill.style.width = Math.min(100, Math.max(0, pct)) + '%';
    cleanPhaseLabel.textContent = label || '';
  }

  cleanBtn.addEventListener('click', async () => {
    if (!cleanDryRun.checked) {
      if (!confirm('⚠️ Mode réel — les entrées orphelines seront supprimées. Continuer ?')) return;
    }
    cleanBtn.disabled = true;
    cleanCancelBtn.classList.remove('hidden');
    cleanLog.classList.remove('hidden'); cleanLog.innerHTML = '';
    cleanProgress.classList.add('hidden'); cleanFill.style.width = '0%';

    try {
      const res = await apiFetch('/admin/clean-media', {
        method: 'POST', body: JSON.stringify({ dry_run: cleanDryRun.checked, verbose: cleanVerbose.checked }),
      });
      cleanReader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await cleanReader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith(':') || !line.startsWith('data:')) continue;
          let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
          if (d.status === 'progress' && d.total > 0) cleanSetProgress((d.done / d.total) * 100, cleanPhaseLabel.textContent);
          if (d.status === 'phase') cleanSetProgress(((d.phase - 1) / 4) * 100, `Phase ${d.phase} : ${d.label}`);
          if (d.status === 'phase_done') cleanSetProgress((d.phase / 4) * 100, cleanPhaseLabel.textContent);
          if (d.status === 'done') cleanSetProgress(100, '✅ Terminé');
          if (!d.line) continue;
          for (const l of d.line.split('\n')) {
            if (!l.trim()) continue;
            let cls = '';
            if (d.status === 'started') cls = 'log-info';
            else if (d.status === 'phase' || d.status === 'phase_done') cls = 'log-phase';
            else if (d.status === 'action') cls = 'log-action';
            else if (d.status === 'done') cls = 'log-summary';
            else if (d.status === 'error') cls = 'log-err';
            else if (d.type === 'orphan_db' || d.type === 'orphan_thumb') cls = 'log-warn';
            else if (d.type === 'unindexed') cls = 'log-muted';
            else if (d.type === 'deleted_db' || d.type === 'deleted_thumb') cls = 'log-err';
            logAppend(cleanLog, cls, l);
          }
        }
      }
    } catch(e) { if (e.name !== 'AbortError') logAppend(cleanLog, 'log-err', '❌ ' + e.message); }
    cleanReader = null; cleanBtn.disabled = false; cleanCancelBtn.classList.add('hidden');
  });

  cleanCancelBtn.addEventListener('click', async () => {
    cleanCancelBtn.disabled = true;
    if (cleanReader) try { await cleanReader.cancel(); } catch(_) {}
    logAppend(cleanLog, 'log-err', '⏹ Interrompu');
    cleanCancelBtn.disabled = false; cleanCancelBtn.classList.add('hidden'); cleanBtn.disabled = false;
  });

  /* ── Purge courtes vidéos ── */
  const shortVidPreviewBtn = document.getElementById('shortVidPreviewBtn');
  const shortVidDeleteBtn  = document.getElementById('shortVidDeleteBtn');
  const shortVidCancelBtn  = document.getElementById('shortVidCancelBtn');
  const shortVidMinutes    = document.getElementById('shortVidMinutes');
  const shortVidProgress   = document.getElementById('shortVidProgress');
  const shortVidFill       = document.getElementById('shortVidFill');
  const shortVidLabel      = document.getElementById('shortVidLabel');
  const shortVidLog        = document.getElementById('shortVidLog');
  let shortVidReader = null;

  async function runPurgeShortVids(dry_run) {
    const maxSec = Math.max(1, Number(shortVidMinutes.value) || 2) * 60;
    shortVidPreviewBtn.disabled = true; shortVidDeleteBtn.disabled = true;
    shortVidCancelBtn.classList.remove('hidden');
    shortVidProgress.classList.remove('hidden'); shortVidFill.style.width = '5%';
    shortVidLabel.textContent = 'Analyse…';
    shortVidLog.classList.remove('hidden'); shortVidLog.innerHTML = '';

    try {
      const res = await apiFetch('/admin/purge-short-videos', {
        method: 'POST', body: JSON.stringify({ max_duration: maxSec, dry_run }),
      });
      shortVidReader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await shortVidReader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith(':') || !line.startsWith('data:')) continue;
          let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
          if (d.status === 'progress' && d.total > 0) {
            shortVidFill.style.width = Math.round(d.done / d.total * 100) + '%';
            shortVidLabel.textContent = `${d.done} / ${d.total}`;
          }
          if (d.status === 'done') { shortVidFill.style.width = '100%'; shortVidLabel.textContent = '✅ Terminé'; }
          if (!d.line) continue;
          const cls = d.status === 'done' ? 'log-summary'
                    : d.status === 'found' ? 'log-phase'
                    : d.status === 'started' ? 'log-action'
                    : (d.status === 'error' || d.status === 'error_item') ? 'log-err'
                    : d.status === 'preview' ? 'log-muted' : '';
          for (const l of d.line.split('\n')) { if (l.trim()) logAppend(shortVidLog, cls, l); }
        }
      }
    } catch(e) { if (e.name !== 'AbortError') logAppend(shortVidLog, 'log-err', '❌ ' + e.message); }
    shortVidReader = null; shortVidPreviewBtn.disabled = false; shortVidDeleteBtn.disabled = false;
    shortVidCancelBtn.classList.add('hidden');
  }

  shortVidPreviewBtn.addEventListener('click', () => runPurgeShortVids(true));
  shortVidDeleteBtn.addEventListener('click', async () => {
    const mins = Number(shortVidMinutes.value) || 2;
    if (!confirm(`⚠️ Supprimer toutes les vidéos de moins de ${mins} minute(s) ? Irréversible.`)) return;
    await runPurgeShortVids(false);
  });
  shortVidCancelBtn.addEventListener('click', async () => {
    shortVidCancelBtn.disabled = true;
    if (shortVidReader) try { await shortVidReader.cancel(); } catch(_) {}
    logAppend(shortVidLog, 'log-err', '⏹ Interrompu');
    shortVidCancelBtn.disabled = false; shortVidCancelBtn.classList.add('hidden');
    shortVidPreviewBtn.disabled = false; shortVidDeleteBtn.disabled = false;
  });

  /* ═══════════════════════════════════════════════════════
     SETTINGS
     ═══════════════════════════════════════════════════════ */
  async function loadSettings() {
    const res = await apiFetch('/admin/settings');
    const s = await res.json();
    document.getElementById('allowReg').checked   = s.allow_registration === 'true' || s.allow_registration === '1';
    document.getElementById('smtpHost').value    = s.smtp_host  || '';
    document.getElementById('smtpPort').value    = s.smtp_port  || '587';
    document.getElementById('smtpUser').value    = s.smtp_user  || '';
    document.getElementById('smtpPass').value    = s.smtp_pass  || '';
    document.getElementById('smtpFrom').value    = s.smtp_from  || '';
    document.getElementById('smtpSecure').checked = s.smtp_secure === 'true';
  }

  document.getElementById('saveRegBtn').addEventListener('click', async () => {
    await apiFetch('/admin/settings', {
      method: 'PUT', body: JSON.stringify({ allow_registration: document.getElementById('allowReg').checked ? 'true' : 'false' }),
    });
    showAlert('smtpTestResult', 'success', '✅ Paramètre sauvegardé');
  });

  document.getElementById('saveSmtpBtn').addEventListener('click', async () => {
    const body = {
      smtp_host: document.getElementById('smtpHost').value,
      smtp_port: document.getElementById('smtpPort').value,
      smtp_user: document.getElementById('smtpUser').value,
      smtp_pass: document.getElementById('smtpPass').value,
      smtp_from: document.getElementById('smtpFrom').value,
      smtp_secure: document.getElementById('smtpSecure').checked ? 'true' : 'false',
    };
    const res = await apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
    const d = await res.json();
    showAlert('smtpTestResult', res.ok ? 'success' : 'error', res.ok ? '✅ SMTP sauvegardé' : d.error);
  });

  document.getElementById('testSmtpBtn').addEventListener('click', async () => {
    const btn = document.getElementById('testSmtpBtn');
    btn.disabled = true;
    const res = await apiFetch('/admin/settings/test-smtp', { method: 'POST' });
    const d = await res.json();
    showAlert('smtpTestResult', res.ok ? 'success' : 'error', res.ok ? '✅ ' + d.message : '❌ ' + d.error);
    btn.disabled = false;
  });

  /* ═══════════════════════════════════════════════════════
     ENCODING
     ═══════════════════════════════════════════════════════ */
  let encInitialized = false;
  let encCaps = null;
  let encEventSource = null;
  let encVideoPage = 1;
  const ENC_LIMIT = 60;

  async function initEncodeTab() {
    if (!encInitialized) {
      encInitialized = true;
      setupEncodeListeners();
    }
    await Promise.all([
      loadHardwareInfo(),
      loadCodecStats(),
      loadEncodeStatus(),
      loadEncodeHistory(),
      loadEncPerformers(),
    ]);
    startEncodeEvents();
  }

  function setupEncodeListeners() {
    document.getElementById('refreshCapsBtn').addEventListener('click', async () => {
      encCaps = null;
      document.getElementById('encHardwareInfo').innerHTML = '<div class="spinner-sm"></div> Détection…';
      await loadHardwareInfo(true);
      await loadCodecStats();
    });

    document.getElementById('encSetWorkersBtn').addEventListener('click', async () => {
      const n = Number(document.getElementById('encMaxWorkers').value) || 2;
      await apiFetch('/admin/encode/workers', { method: 'POST', body: JSON.stringify({ maxWorkers: n }) });
    });

    document.getElementById('encCancelAllBtn').addEventListener('click', async () => {
      if (!confirm('Annuler tous les jobs d\'encodage en cours et en attente ?')) return;
      await apiFetch('/admin/encode/cancel-all', { method: 'POST' });
      await loadEncodeStatus();
    });

    document.getElementById('encLoadVideosBtn').addEventListener('click', () => { encVideoPage = 1; loadEncodeVideos(); });
    document.getElementById('encFilterSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { encVideoPage = 1; loadEncodeVideos(); } });

    document.getElementById('encSelectAllBtn').addEventListener('click', () => {
      document.querySelectorAll('#encVideoGrid .enc-vcard-cb').forEach(cb => {
        if (!cb.closest('.enc-vcard').classList.contains('enc-queued')) {
          cb.checked = true; cb.closest('.enc-vcard').classList.add('enc-selected');
        }
      });
      updateEncSel();
    });
    document.getElementById('encUnselectBtn').addEventListener('click', () => {
      document.querySelectorAll('#encVideoGrid .enc-vcard-cb').forEach(cb => {
        cb.checked = false; cb.closest('.enc-vcard').classList.remove('enc-selected');
      });
      updateEncSel();
    });

    document.getElementById('encEnqueueBtn').addEventListener('click', enqueueSelected);

    document.getElementById('encClearLogsBtn').addEventListener('click', () => {
      document.getElementById('encLogs').innerHTML = '';
    });
  }

  /* ── Hardware Info ── */
  async function loadHardwareInfo(refresh = false) {
    try {
      const url = '/admin/encode/capabilities' + (refresh ? '?refresh=1' : '');
      const res = await apiFetch(url);
      encCaps = await res.json();
      renderHardwareInfo(encCaps);
      populatePresetSelect(encCaps.presets);
    } catch(e) {
      document.getElementById('encHardwareInfo').innerHTML = `<span style="color:var(--a-red)">❌ ${esc(e.message)}</span>`;
    }
  }

  function renderHardwareInfo(caps) {
    const el = document.getElementById('encHardwareInfo');
    const chips = [];

    if (caps.nvidia.length) {
      for (const gpu of caps.nvidia) {
        chips.push(`<span class="hw-chip hw-chip-gpu">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg>
          ${esc(gpu.name)} (${gpu.vram})
        </span>`);
      }
    }

    if (caps.vaapi.length) {
      for (const dev of caps.vaapi) {
        chips.push(`<span class="hw-chip hw-chip-vaapi">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h4M14 12h4"/></svg>
          ${esc(dev.vendor)} VA-API (${esc(dev.device)})
        </span>`);
      }
    }

    // CPU encoders
    const cpuEncoders = caps.encoders.filter(e => e.startsWith('lib'));
    if (cpuEncoders.length) {
      chips.push(`<span class="hw-chip hw-chip-cpu">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/></svg>
        CPU : ${cpuEncoders.join(', ')}
      </span>`);
    }

    if (!chips.length) {
      chips.push(`<span class="hw-chip hw-chip-none">Aucun encodeur GPU détecté — CPU uniquement</span>`);
    }

    el.innerHTML = chips.join('');
  }

  function populatePresetSelect(presets) {
    const sel = document.getElementById('encPreset');
    sel.innerHTML = '';
    if (!presets.length) {
      sel.innerHTML = '<option value="">Aucun preset disponible</option>';
      return;
    }
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      sel.appendChild(opt);
    }
  }

  /* ── Codec Stats ── */
  async function loadCodecStats() {
    try {
      const res = await apiFetch('/admin/encode/codec-stats');
      const stats = await res.json();
      const el = document.getElementById('encCodecStats');
      if (!stats.length) { el.innerHTML = '<div style="color:var(--a-text-muted);padding:16px">Aucune vidéo indexée.</div>'; return; }
      el.innerHTML = stats.map(s => `
        <div class="codec-card">
          <div class="cc-name">${esc(s.codec)}</div>
          <div class="cc-count">${s.count}</div>
          <div class="cc-size">${fmtSize(s.total_size)}</div>
        </div>
      `).join('');
    } catch {}
  }

  /* ── Queue Status ── */
  async function loadEncodeStatus() {
    try {
      const res = await apiFetch('/admin/encode/status');
      const data = await res.json();
      document.getElementById('encStatEncoding').textContent = data.encoding;
      document.getElementById('encStatPending').textContent = data.pending;
      document.getElementById('encStatDone').textContent = data.done;
      document.getElementById('encStatErrors').textContent = data.errored;
      document.getElementById('encMaxWorkers').value = data.maxWorkers;
      renderActiveJobs(data.activeJobs);
    } catch {}
  }

  function renderActiveJobs(jobs) {
    const el = document.getElementById('encActiveJobs');
    if (!jobs || !jobs.length) {
      el.innerHTML = '<div style="color:var(--a-text-muted);padding:12px;text-align:center;font-size:12px">Aucun job en cours.</div>';
      return;
    }
    el.innerHTML = jobs.map(j => {
      const isRunning = j.status === 'encoding';
      const dotClass = isRunning ? 'dot-encoding' : 'dot-pending';
      return `
        <div class="enc-job" data-job-id="${j.id}">
          <span class="enc-job-status dot ${dotClass}"></span>
          <div class="enc-job-info">
            <div class="enc-job-name">${esc(j.filename || j.file_path?.split('/').pop() || `Job #${j.id}`)}</div>
            <div class="enc-job-meta">${esc(j.performer_name)} — ${esc(j.encoder)} → ${esc(j.target_codec)}</div>
          </div>
          <div class="enc-job-progress">
            <div class="progress-bar"><div class="progress-fill" style="width:${j.progress || 0}%"></div></div>
            <div class="enc-job-pct">${j.progress || 0}%</div>
          </div>
          <div class="enc-job-actions">
            <button class="btn btn-xs btn-danger" onclick="cancelEncJob(${j.id})">✕</button>
          </div>
        </div>
      `;
    }).join('');
  }

  window.cancelEncJob = async (id) => {
    await apiFetch(`/admin/encode/cancel/${id}`, { method: 'POST' });
    await loadEncodeStatus();
  };

  /* ── SSE Events ── */
  function startEncodeEvents() {
    if (encEventSource) return;
    try {
      // Pass JWT via query param since EventSource can't set Authorization header
      encEventSource = new EventSource(`/admin/encode/events?token=${encodeURIComponent(token())}`);
    } catch {}

    // Use polling fallback if connection fails
    if (!encEventSource || encEventSource.readyState === 2) {
      encEventSource = null;
      startEncodePolling();
      return;
    }

    encEventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        handleEncodeEvent(data);
      } catch {}
    };

    encEventSource.onerror = () => {
      encEventSource.close();
      encEventSource = null;
      startEncodePolling();
    };
  }

  let _encPollTimer = null;
  function startEncodePolling() {
    if (_encPollTimer) return;
    _encPollTimer = setInterval(async () => {
      // Only poll if encode tab is visible
      const tab = document.getElementById('tab-encode');
      if (!tab || !tab.classList.contains('active')) return;
      await loadEncodeStatus();
    }, 3000);
  }

  function handleEncodeEvent(data) {
    // Update progress bars in the active jobs list
    if (data.type === 'job_progress') {
      const jobEl = document.querySelector(`.enc-job[data-job-id="${data.jobId}"]`);
      if (jobEl) {
        const fill = jobEl.querySelector('.progress-fill');
        const pct = jobEl.querySelector('.enc-job-pct');
        if (fill) fill.style.width = data.progress + '%';
        if (pct) pct.textContent = data.progress + '%';
      }
    }
    if (['job_done', 'job_error', 'job_cancelled', 'all_cancelled', 'job_started'].includes(data.type)) {
      loadEncodeStatus();
      if (data.type === 'job_done') loadEncodeHistory();
    }

    // Append to live log panel
    encLogEvent(data);
  }

  /** Format an SSE encode event into a readable log line in the UI */
  function encLogEvent(data) {
    const logEl = document.getElementById('encLogs');
    if (!logEl) return;
    const ts = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let cls = '', text = '';
    switch (data.type) {
      case 'job_started':
        cls = 'log-info'; text = `▶ Job #${data.jobId} démarré (media ${data.mediaId})`; break;
      case 'job_progress':
        if (data.progress % 10 === 0 || data.progress >= 99) {
          cls = 'log-muted'; text = `⏳ Job #${data.jobId} — ${data.progress}%`;
          if (data.speed) text += ` (${data.speed})`;
        } else return; // skip noisy intermediate updates
        break;
      case 'job_speed':
        return; // handled via job_progress
      case 'job_done':
        cls = 'log-phase';
        text = `✅ Job #${data.jobId} terminé`;
        if (data.inputSize && data.outputSize) {
          const saved = ((1 - data.outputSize / data.inputSize) * 100).toFixed(1);
          text += ` — ${fmtSize(data.inputSize)} → ${fmtSize(data.outputSize)} (${saved}% économisé)`;
        }
        break;
      case 'job_error':
        cls = 'log-err'; text = `❌ Job #${data.jobId} échoué : ${data.error || 'erreur inconnue'}`; break;
      case 'job_cancelled':
        cls = 'log-err'; text = `⏹ Job #${data.jobId} annulé`; break;
      case 'all_cancelled':
        cls = 'log-err'; text = '⏹ Tous les jobs annulés'; break;
      case 'job_replace_error':
        cls = 'log-err'; text = `⚠️ Job #${data.jobId} : erreur remplacement original : ${data.error}`; break;
      default:
        cls = 'log-muted'; text = JSON.stringify(data);
    }
    logAppend(logEl, cls, `[${ts}] ${text}`);
  }

  /* ── Video Selection ── */
  async function loadEncPerformers() {
    const sel = document.getElementById('encFilterPerformer');
    if (sel.options.length > 1) return;
    try {
      const res = await apiFetch('/api/performers?limit=200&sort=name&order=asc');
      const { data } = await res.json();
      data.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id; opt.textContent = p.name;
        sel.appendChild(opt);
      });
    } catch {}
  }

  async function loadEncodeVideos() {
    const grid = document.getElementById('encVideoGrid');
    const toolbar = document.getElementById('encToolbar');
    const pag = document.getElementById('encPagination');
    grid.innerHTML = ''; grid.classList.remove('hidden');
    toolbar.classList.remove('hidden'); pag.innerHTML = '';

    const params = new URLSearchParams({
      page: encVideoPage, limit: ENC_LIMIT,
    });
    const performer = document.getElementById('encFilterPerformer').value;
    const codec = document.getElementById('encFilterCodec').value;
    const q = document.getElementById('encFilterSearch').value.trim();
    if (performer) params.set('performer_id', performer);
    if (codec) params.set('codec', codec);
    if (q) params.set('q', q);

    try {
      const res = await apiFetch(`/admin/encode/videos?${params}`);
      const { data, total } = await res.json();

      if (!data.length) {
        grid.innerHTML = '<div class="mb-empty">Aucune vidéo trouvée.</div>';
        updateEncSel(); return;
      }

      data.forEach(item => {
        const card = document.createElement('div');
        card.className = 'enc-vcard';
        if (item.encode_status) card.classList.add('enc-queued');
        card.dataset.id = item.id;

        const codecTag = item.codec
          ? `<span class="enc-tag enc-tag-${(item.codec || '').toLowerCase()}">${esc(item.codec)}</span>`
          : '';
        const res = item.width && item.height ? `${item.width}×${item.height}` : '';

        card.innerHTML = `
          <input class="enc-vcard-cb" type="checkbox" data-id="${item.id}" ${item.encode_status ? 'disabled' : ''}>
          <img class="enc-vcard-thumb" src="/thumb/${item.id}" loading="lazy" onerror="this.style.opacity='.3'">
          <div class="enc-vcard-info">
            <div class="enc-vcard-name" title="${esc(item.file_path)}">${esc(item.filename || item.file_path?.split('/').pop())}</div>
            <div class="enc-vcard-meta">
              <span>${esc(item.performer_name)}</span>
              ${codecTag}
              ${res ? `<span>${res}</span>` : ''}
              <span>${fmtSize(item.size)}</span>
              ${item.duration ? `<span>${fmtDuration(item.duration)}</span>` : ''}
              ${item.encode_status ? `<span class="enc-tag" style="background:rgba(234,179,8,.1);color:var(--a-yellow);border-color:rgba(234,179,8,.2)">${item.encode_status}</span>` : ''}
            </div>
          </div>
        `;

        if (!item.encode_status) {
          card.addEventListener('click', e => {
            if (e.target.classList.contains('enc-vcard-cb')) return;
            const cb = card.querySelector('.enc-vcard-cb');
            cb.checked = !cb.checked; card.classList.toggle('enc-selected', cb.checked); updateEncSel();
          });
          card.querySelector('.enc-vcard-cb').addEventListener('change', e => {
            card.classList.toggle('enc-selected', e.target.checked); updateEncSel();
          });
        }
        grid.appendChild(card);
      });

      // Pagination
      const pages = Math.ceil(total / ENC_LIMIT);
      if (pages > 1) {
        const info = document.createElement('span');
        info.style.cssText = 'font-size:11px;color:var(--a-text-muted);margin-right:8px';
        info.textContent = `${total} vidéo(s) — page ${encVideoPage}/${pages}`;
        pag.appendChild(info);
        if (encVideoPage > 1) {
          const prev = document.createElement('button');
          prev.className = 'page-btn'; prev.textContent = '‹';
          prev.addEventListener('click', () => { encVideoPage--; loadEncodeVideos(); });
          pag.appendChild(prev);
        }
        if (encVideoPage < pages) {
          const next = document.createElement('button');
          next.className = 'page-btn'; next.textContent = '›';
          next.addEventListener('click', () => { encVideoPage++; loadEncodeVideos(); });
          pag.appendChild(next);
        }
      }
    } catch(e) {
      grid.innerHTML = `<div class="mb-empty">❌ ${esc(e.message)}</div>`;
    }
    updateEncSel();
  }

  function updateEncSel() {
    const total = document.querySelectorAll('#encVideoGrid .enc-vcard-cb:not(:disabled)').length;
    const checked = document.querySelectorAll('#encVideoGrid .enc-vcard-cb:checked').length;
    document.getElementById('encSelCount').textContent = `${checked} / ${total}`;
    const btn = document.getElementById('encEnqueueBtn');
    btn.disabled = checked === 0;
    btn.textContent = `⚡ Encoder${checked ? ` (${checked})` : ''}`;
  }

  async function enqueueSelected() {
    const preset = document.getElementById('encPreset').value;
    if (!preset) { alert('Veuillez sélectionner un preset d\'encodage.'); return; }

    const checked = [...document.querySelectorAll('#encVideoGrid .enc-vcard-cb:checked')];
    if (!checked.length) return;
    const mediaIds = checked.map(cb => Number(cb.dataset.id));
    const quality = document.getElementById('encQuality').value;
    const replaceOriginal = document.getElementById('encReplace').checked;

    if (replaceOriginal && !confirm(`⚠️ ${mediaIds.length} vidéo(s) seront ré-encodées et les originaux remplacés. Continuer ?`)) return;

    try {
      const res = await apiFetch('/admin/encode/enqueue', {
        method: 'POST',
        body: JSON.stringify({ mediaIds, presetId: preset, quality, replaceOriginal }),
      });
      const data = await res.json();
      if (data.jobIds?.length) {
        showToast(`${data.jobIds.length} job(s) ajouté(s) à la file`);
        const logEl = document.getElementById('encLogs');
        const ts = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        logAppend(logEl, 'log-action', `[${ts}] 📤 ${data.jobIds.length} job(s) ajouté(s) — preset=${preset}, quality=${quality}, replace=${replaceOriginal}`);
        // Mark cards as queued
        checked.forEach(cb => {
          cb.checked = false; cb.disabled = true;
          const card = cb.closest('.enc-vcard');
          card.classList.remove('enc-selected');
          card.classList.add('enc-queued');
        });
        updateEncSel();
        await loadEncodeStatus();
      } else {
        showToast('Tous les médias sont déjà en file d\'attente');
      }
    } catch(e) { alert('Erreur : ' + e.message); }
  }

  /* ── History ── */
  let encHistPage = 1;

  async function loadEncodeHistory() {
    try {
      const res = await apiFetch(`/admin/encode/history?page=${encHistPage}&limit=30`);
      const { data, total, limit } = await res.json();
      const el = document.getElementById('encHistory');
      const pag = document.getElementById('encHistoryPag');

      if (!data.length) {
        el.innerHTML = '<div class="enc-hist-empty">Aucun encodage effectué.</div>';
        pag.innerHTML = '';
        return;
      }

      el.innerHTML = data.map(j => {
        const statusDot = j.status === 'done' ? 'dot-done'
                        : j.status === 'error' ? 'dot-error'
                        : j.status === 'cancelled' ? 'dot-pending'
                        : j.status === 'encoding' ? 'dot-encoding'
                        : 'dot-pending';

        const saved = j.file_size_before && j.file_size_after
          ? Math.round((1 - j.file_size_after / j.file_size_before) * 100)
          : null;
        const savedClass = saved !== null ? (saved > 0 ? 'saved-good' : 'saved-bad') : '';
        const savedText = saved !== null ? `${saved > 0 ? '-' : '+'}${Math.abs(saved)}%` : '—';

        return `
          <div class="enc-hist-row">
            <span class="enc-hist-status dot ${statusDot}"></span>
            <span class="enc-hist-name" title="${esc(j.file_path)}">${esc(j.filename || '?')}</span>
            <span class="enc-hist-codec">${esc(j.encoder)} → ${esc(j.target_codec)}</span>
            <span class="enc-hist-size">${fmtSize(j.file_size_before)} → ${fmtSize(j.file_size_after)}</span>
            <span class="enc-hist-saved ${savedClass}">${savedText}</span>
            <span class="enc-hist-date">${j.finished_at ? fmtDate(j.finished_at) : '—'}</span>
            <div class="enc-hist-actions">
              ${j.status === 'error' || j.status === 'cancelled' ? `<button class="btn btn-xs" onclick="retryEncJob(${j.id})" title="Réessayer">↻</button>` : ''}
              <button class="btn btn-xs btn-danger" onclick="deleteEncJob(${j.id})" title="Supprimer">✕</button>
            </div>
          </div>
        `;
      }).join('');

      // Pagination
      const pages = Math.ceil(total / limit);
      pag.innerHTML = '';
      if (pages > 1) {
        for (let p = 1; p <= Math.min(pages, 10); p++) {
          const btn = document.createElement('button');
          btn.className = 'page-btn' + (p === encHistPage ? ' active' : '');
          btn.textContent = p;
          btn.addEventListener('click', () => { encHistPage = p; loadEncodeHistory(); });
          pag.appendChild(btn);
        }
      }
    } catch {}
  }

  window.retryEncJob = async (id) => {
    await apiFetch(`/admin/encode/retry/${id}`, { method: 'POST' });
    await loadEncodeStatus();
    await loadEncodeHistory();
  };

  window.deleteEncJob = async (id) => {
    if (!confirm('Supprimer ce job ?')) return;
    await apiFetch(`/admin/encode/job/${id}`, { method: 'DELETE' });
    await loadEncodeHistory();
  };

  /* ═══════════════════════════════════════════════════════
     HELPERS
     ═══════════════════════════════════════════════════════ */
  function esc(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmtDate(dt) {
    if (!dt) return '—';
    return new Date(dt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtSize(bytes) {
    if (!bytes) return '—';
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' Go';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' Mo';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + ' Ko';
    return bytes + ' o';
  }
  function fmtDuration(sec) {
    if (!sec) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    if (m >= 60) return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function logAppend(el, cls, text) {
    if (!text) return;
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    el.appendChild(span);
    el.appendChild(document.createTextNode('\n'));
    el.scrollTop = el.scrollHeight;
  }
  function showAlert(id, type, msg) {
    const el = document.getElementById(id);
    el.className = `alert alert-${type}`;
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 5000);
  }
  function showToast(msg) {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;background:var(--a-green);color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:500;box-shadow:0 4px 20px rgba(0,0,0,.3);animation:fadeIn .3s ease';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity .3s'; setTimeout(() => toast.remove(), 300); }, 3000);
  }

  // Start
  boot();
})();
