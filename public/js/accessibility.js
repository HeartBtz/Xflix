(function () {
  'use strict';
  const cards = '[data-performer], [data-video-id], [data-photo-id], #navBrand, a.dropdown-item:not([href])';
  function prepare(root) {
    const elements = [...root.querySelectorAll(cards)];
    if (root.matches?.(cards)) elements.push(root);
    for (const el of elements) {
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      if (!el.hasAttribute('aria-label')) {
        el.setAttribute('aria-label', el.querySelector('img')?.alt || el.textContent.trim() || 'Ouvrir le media');
      }
    }
    root.querySelectorAll('button[title], a[title], select[title]').forEach(el => {
      if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.title);
    });
    root.querySelectorAll('.form-group, .filter-group').forEach(group => {
      const label = group.querySelector('label'), input = group.querySelector('input, select, textarea');
      if (label && input?.id && !label.contains(input)) label.htmlFor = input.id;
    });
  }
  prepare(document);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType === 1) prepare(node);
    }
  }).observe(document.body, { childList: true, subtree: true });

  const dialogs = [...document.querySelectorAll('.modal-overlay')];
  const closeIds = { videoModal: 'closeVideo', photoModal: 'closePhoto', authModal: 'closeAuth',
    profileModal: 'closeProfile', manageModal: 'closeManage', statsModal: 'closeStats' };
  let stack = [];
  const returnFocus = new Map();
  const focusable = dialog => [...dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')]
    .filter(el => !el.disabled && el.getClientRects().length && !el.closest('[inert]'));
  const sync = () => {
    const oldTop = stack.at(-1);
    const opened = dialogs.filter(el => !el.classList.contains('hidden'));
    const added = opened.filter(el => !stack.includes(el));
    for (const dialog of added) returnFocus.set(dialog, document.activeElement);
    stack = [...stack.filter(el => opened.includes(el)), ...added];
    const top = stack.at(-1);
    for (const el of document.body.children) {
      if (el.tagName === 'SCRIPT' || el.id === 'toast') continue;
      el.inert = Boolean(top && el !== top);
    }
    document.body.style.overflow = top ? 'hidden' : '';
    if (top !== oldTop) {
      if (top) (focusable(top)[0] || top).focus();
      else {
        const previous = returnFocus.get(oldTop);
        if (previous?.isConnected && previous.getClientRects().length) previous.focus();
        else document.getElementById('navBrand')?.focus();
      }
    }
  };
  for (const dialog of dialogs) {
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;
    new MutationObserver(sync).observe(dialog, { attributes: true, attributeFilter: ['class'] });
  }
  document.addEventListener('keydown', event => {
    const top = stack.at(-1);
    if (top && event.key === 'Escape') {
      if (document.fullscreenElement) return;
      event.preventDefault(); event.stopImmediatePropagation();
      document.getElementById(closeIds[top.id])?.click();
      return;
    }
    if (top && event.key === 'Tab') {
      const items = focusable(top), first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); top.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches(cards)) {
      event.preventDefault(); event.stopImmediatePropagation(); event.target.click();
    }
  }, true);
})();
