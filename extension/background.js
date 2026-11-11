import { addStep, countSteps } from './lib/db.js';

const CAPTURE_GAP_MS = 550; // Chrome allows about two captures per second
const MAX_HEIGHT_PX = 30000; // browsers cannot reliably build a taller image
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits the delay chosen in the popup, counting down on the toolbar icon.
async function countdown() {
  const { captureDelay = 0 } = await chrome.storage.local.get('captureDelay');
  for (let left = Number(captureDelay) || 0; left > 0; left--) {
    await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
    await chrome.action.setBadgeText({ text: String(left) });
    await sleep(1000);
  }
  await chrome.action.setBadgeText({ text: '' });
}

async function refreshBadge() {
  const count = await countSteps();
  await chrome.action.setBadgeBackgroundColor({ color: '#1f6feb' });
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
  await chrome.action.setTitle({ title: `QAssistant: ${count} screenshot${count === 1 ? '' : 's'}` });
}

chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);

function friendlyError(error) {
  const message = String(error?.message || error);
  if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\/|permission|activeTab|all_urls/i.test(message)) {
    return 'Chrome does not allow screenshots of this page. Try a normal website, or click the extension icon on the page again.';
  }
  return message;
}

// Chrome limits how often a tab can be captured, so wait and retry once.
async function captureTab(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (error) {
    if (!/MAX_CAPTURE_VISIBLE_TAB/.test(String(error?.message))) throw error;
    await sleep(CAPTURE_GAP_MS + 150);
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  }
}

async function frameToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

// Query strings and fragments can hold tokens or personal data, so they are never stored.
function safeAddress(url) {
  try {
    const { protocol, origin, pathname } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? `${origin}${pathname}` : '';
  } catch {
    return '';
  }
}

async function saveCapture(tab, blob, width, height, scale, extra = {}) {
  const id = crypto.randomUUID();
  await addStep({
    id,
    image: blob,
    width,
    height,
    scale,
    title: '',
    notes: '',
    annotations: [],
    url: safeAddress(tab.url),
    pageTitle: '',
    capturedAt: Date.now(),
    tabId: tab.id,
    ...extra,
  });
  await refreshBadge();
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`editor.html?id=${id}`),
    index: tab.index + 1,
    openerTabId: tab.id,
    windowId: tab.windowId,
  });
  return id;
}

async function captureVisible(tab) {
  await countdown();
  const dataUrl = await captureTab(tab.windowId);
  const [{ result: viewport }] = await chrome.scripting
    .executeScript({ target: { tabId: tab.id }, func: () => window.innerWidth })
    .catch(() => [{ result: null }]);
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  bitmap.close();
  await saveCapture(tab, blob, width, height, viewport ? width / viewport : 1);
}

// ---- These functions run inside the page being captured. ----

function pagePrepare(underMouse) {
  const state = { hidden: new Map() };
  window.__qassistant = state;

  const style = document.createElement('style');
  style.textContent = `
    html, body, * { scroll-behavior: auto !important; }
    html, body { scrollbar-width: none !important; }
    html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }`;
  document.documentElement.appendChild(style);
  state.style = style;

  const root = document.scrollingElement || document.documentElement;
  const visibleArea = (el) => {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  };
  const scrolls = (el) => {
    if (el.scrollHeight <= el.clientHeight + 2 || el.clientHeight < 60) return false;
    const overflow = getComputedStyle(el).overflowY;
    return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
  };
  // Every element, including those inside open shadow roots (used by apps such as Salesforce).
  const everything = (start) => {
    const out = [];
    const walk = (node) => {
      for (const el of node.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(start);
    return out;
  };
  const parentOf = (el) => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  const largestScroller = (elements) => {
    let best = null;
    let bestArea = 0;
    for (const el of elements) {
      if (!scrolls(el)) continue;
      const area = visibleArea(el);
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  };

  let scroller = null;

  // 1. The area under the mouse, when that option is on.
  if (underMouse) {
    let hovered = null;
    let scope = document;
    for (let depth = 0; depth < 20; depth++) {
      const chain = scope.querySelectorAll(':hover');
      const last = chain[chain.length - 1];
      if (!last) break;
      hovered = last;
      if (!last.shadowRoot) break;
      scope = last.shadowRoot;
    }
    for (let el = hovered; el && el !== document.documentElement && el !== document.body; el = parentOf(el)) {
      if (scrolls(el)) {
        scroller = el;
        break;
      }
    }
  }

  // 2. An open pop-up window, such as a "New record" dialog.
  if (!scroller) {
    const dialogs = everything(document).filter((el) => (
      el.matches('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .slds-modal')
      && visibleArea(el) > 0 && getComputedStyle(el).visibility !== 'hidden'
    ));
    const dialog = dialogs.sort((a, b) => visibleArea(b) - visibleArea(a))[0];
    if (dialog) {
      scroller = (scrolls(dialog) ? dialog : null) || largestScroller(everything(dialog));
      // A pop-up that doesn't scroll is captured as it is, without scrolling the page behind it.
      if (!scroller) scroller = dialog;
    }
  }

  // 3. The page itself, or else its largest scrolling area.
  if (!scroller) {
    scroller = root.scrollHeight > window.innerHeight + 2 ? root : (largestScroller(everything(document)) || root);
  }
  state.scroller = scroller;
  state.isRoot = scroller === root;
  if (!state.isRoot) {
    state.scrollbarWidth = scroller.style.getPropertyValue('scrollbar-width');
    scroller.style.setProperty('scrollbar-width', 'none', 'important');
  }
  state.startTop = scroller.scrollTop;
  state.startLeft = window.scrollX;
  window.scrollTo(0, window.scrollY);

  const box = state.isRoot
    ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
    : (({ left, top, width, height }) => ({ left, top, width, height }))(scroller.getBoundingClientRect());

  // In apps that scroll inside a panel (chats, mail), find the bars and boxes that
  // float over it: they stay put while the panel scrolls. Each is shown only once.
  state.overlays = [];
  if (!state.isRoot) {
    const b = scroller.getBoundingClientRect();
    const candidates = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el === scroller || el.contains(scroller)) continue;
      const css = getComputedStyle(el);
      if (css.position !== 'fixed' && css.position !== 'sticky' && css.position !== 'absolute') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.height > b.height * 0.5) continue;
      const overlapW = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const overlapH = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      if (overlapW <= 0 || overlapH <= 0) continue;
      candidates.push({ el, top: r.top, isBottom: r.top + r.height / 2 > b.top + b.height / 2 });
    }
    const start = scroller.scrollTop;
    const room = scroller.scrollHeight - scroller.clientHeight;
    const shift = room - start >= 40 ? Math.min(240, room - start) : -Math.min(240, start);
    if (shift) {
      scroller.scrollTop = start + shift;
      const moved = scroller.scrollTop - start;
      const floating = candidates.filter((c) => Math.abs(c.el.getBoundingClientRect().top - c.top) < 1 && Math.abs(moved) > 20);
      state.overlays = floating.filter((c) => !floating.some((other) => other !== c && other.el.contains(c.el)));
      scroller.scrollTop = start;
    }
  }
  return { box, isRoot: state.isRoot, viewportWidth: window.innerWidth };
}

// Hides fixed and stuck elements so a site header or footer appears only once.
function pageScrollTo(top, position) {
  const state = window.__qassistant;
  const { scroller } = state;

  for (const [el, previous] of state.hidden) {
    if (previous) el.style.setProperty('visibility', previous);
    else el.style.removeProperty('visibility');
  }
  state.hidden.clear();
  scroller.scrollTop = top;

  if (state.isRoot) {
    const viewH = window.innerHeight;
    const hide = (el) => {
      state.hidden.set(el, el.style.getPropertyValue('visibility'));
      el.style.setProperty('visibility', 'hidden', 'important');
    };
    for (const el of document.querySelectorAll('body *')) {
      const css = getComputedStyle(el);
      if (css.position !== 'fixed' && css.position !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.height > viewH * 0.7) continue;
      if (css.position === 'sticky') {
        const stick = parseFloat(css.top);
        if (scroller.scrollTop > 0 && !Number.isNaN(stick) && Math.abs(r.top - stick) <= 1) hide(el);
        continue;
      }
      const isBottom = r.top + r.height / 2 > viewH / 2;
      if (isBottom ? position !== 'last' : position !== 'first') hide(el);
    }
  } else {
    for (const { el, isBottom } of state.overlays) {
      if (isBottom ? position === 'last' : position === 'first') continue;
      state.hidden.set(el, el.style.getPropertyValue('visibility'));
      el.style.setProperty('visibility', 'hidden', 'important');
    }
  }
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      resolve({
        top: scroller.scrollTop,
        total: scroller.scrollHeight,
        view: scroller.clientHeight || window.innerHeight,
      });
    }));
  });
}

function pageRestore() {
  const state = window.__qassistant;
  if (!state) return;
  for (const [el, previous] of state.hidden) {
    if (previous) el.style.setProperty('visibility', previous);
    else el.style.removeProperty('visibility');
  }
  state.style.remove();
  if (!state.isRoot) {
    if (state.scrollbarWidth) state.scroller.style.setProperty('scrollbar-width', state.scrollbarWidth);
    else state.scroller.style.removeProperty('scrollbar-width');
  }
  state.scroller.scrollTop = state.startTop;
  delete window.__qassistant;
}

// ---- End of the functions that run inside the page. ----

async function inPage(tabId, func, ...args) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return injection.result;
}

async function assertStillActive(tab) {
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (active?.id !== tab.id) throw new Error('Capture stopped because you switched tabs. Stay on the page until it finishes.');
}

async function stitchFullPage(tab) {
  const { scrollUnderMouse = false } = await chrome.storage.local.get('scrollUnderMouse');
  const prep = await inPage(tab.id, pagePrepare, scrollUnderMouse);
  const frames = [];
  let truncated = false;
  try {
    let top = 0;
    let lastShot = 0;
    let index = 0;
    let measured = await inPage(tab.id, pageScrollTo, 0, 'first');

    for (;;) {
      top = measured.top;
      await sleep(Math.max(120, CAPTURE_GAP_MS - (Date.now() - lastShot)));
      await assertStillActive(tab);
      lastShot = Date.now();
      const bitmap = await frameToBitmap(await captureTab(tab.windowId));
      frames.push({ bitmap, top });
      index += 1;
      await chrome.action.setBadgeText({ text: `${index}…` });

      const scale = bitmap.width / prep.viewportWidth;
      if ((top + prep.box.height) * scale >= MAX_HEIGHT_PX) {
        truncated = top + prep.box.height < measured.total;
        break;
      }
      if (top + measured.view >= measured.total - 1) break;

      const next = top + measured.view;
      const isLast = next + measured.view >= measured.total - 1;
      measured = await inPage(tab.id, pageScrollTo, next, isLast ? 'last' : 'middle');
      if (measured.top <= top) break;
    }
  } finally {
    await inPage(tab.id, pageRestore).catch(() => {});
    await refreshBadge();
  }

  const scale = frames[0].bitmap.width / prep.viewportWidth;
  const sx = Math.round(prep.box.left * scale);
  const sy = Math.round(prep.box.top * scale);
  const width = Math.round(prep.box.width * scale);
  const frameHeight = Math.round(prep.box.height * scale);
  const last = frames[frames.length - 1];
  const height = Math.min(MAX_HEIGHT_PX, Math.round(last.top * scale) + frameHeight);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  for (const frame of frames) {
    ctx.drawImage(frame.bitmap, sx, sy, width, frameHeight, 0, Math.round(frame.top * scale), width, frameHeight);
  }

  // For a panel or pop-up, also build the whole tab with that area stretched in place,
  // so the rest of the page, the pop-up's title and its buttons stay in the image.
  let whole = null;
  if (!prep.isRoot) {
    const first = frames[0].bitmap;
    const lastFrame = last.bitmap;
    const fullW = first.width;
    const fullH = first.height;
    const extra = height - frameHeight;
    const bottom = sy + frameHeight;
    const wc = new OffscreenCanvas(fullW, fullH + extra);
    const w = wc.getContext('2d');
    w.drawImage(first, 0, 0, fullW, bottom, 0, 0, fullW, bottom);
    if (extra > 0) w.drawImage(first, 0, bottom - 1, fullW, 1, 0, bottom, fullW, extra);
    w.drawImage(lastFrame, 0, bottom, fullW, fullH - bottom, 0, bottom + extra, fullW, fullH - bottom);
    w.drawImage(canvas, sx, sy);
    whole = { canvas: wc, headerHeight: sy, footerHeight: fullH - bottom, viewHeight: fullH };
  }
  for (const frame of frames) frame.bitmap.close();
  return {
    bitmap: await createImageBitmap(canvas),
    width, height, scale, sx, sy, frameHeight, truncated, whole,
    isRoot: prep.isRoot,
  };
}

async function captureFull(tab) {
  await countdown();
  const shot = await stitchFullPage(tab);
  let canvas;
  let layout;
  if (shot.whole) {
    canvas = shot.whole.canvas;
    layout = {
      headerHeight: shot.whole.headerHeight, // the page above the scrolled area
      footerHeight: shot.whole.footerHeight, // the page below it, such as a pop-up's buttons
      screenHeight: shot.whole.viewHeight,
    };
  } else {
    canvas = new OffscreenCanvas(shot.width, shot.height);
    canvas.getContext('2d').drawImage(shot.bitmap, 0, 0);
    layout = { viewHeight: shot.frameHeight }; // one screen of the page, for splitting by screen
  }
  shot.bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  await saveCapture(tab, blob, canvas.width, canvas.height, shot.scale, {
    truncated: shot.truncated,
    panelOnly: !shot.isRoot,
    ...layout,
  });
}

// ---- Entire screen, including the Windows taskbar and clock ----

const toScreen = (message) => chrome.runtime.sendMessage({ target: 'screen', ...message });

async function screenIsShared() {
  try {
    return Boolean((await toScreen({ type: 'status' }))?.active);
  } catch {
    return false; // no sharing window is open
  }
}

let pendingPick = null;

// Resolves with the sharing window's id, or null if cancelled.
function pickScreen() {
  return new Promise((resolve, reject) => {
    pendingPick = { resolve, reject, windowId: null };
    chrome.windows.create({ url: 'pick.html', type: 'popup', width: 760, height: 620, focused: true })
      .then((created) => { if (pendingPick) pendingPick.windowId = created.id; })
      .catch(reject);
  });
}

function onScreenPicked({ ok, error }, windowId) {
  const pick = pendingPick;
  pendingPick = null;
  if (!pick) return;
  if (ok) pick.resolve(windowId);
  else if (error) pick.reject(new Error(error));
  else pick.resolve(null);
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (pendingPick?.windowId === windowId) {
    pendingPick.resolve(null);
    pendingPick = null;
  }
});

// Returns one frame of the desktop, or null if the person cancelled the chooser.
async function grabDesktop(tab) {
  if (!(await chrome.permissions.contains({ permissions: ['desktopCapture'] }))) {
    throw new Error('Turn on screen capture first: click the extension icon, then Capture entire screen.');
  }
  if (await screenIsShared()) {
    await sleep(350); // lets the extension popup close, so it is not in the image
  } else {
    const windowId = await pickScreen();
    if (!windowId) return null;
    await chrome.windows.update(windowId, { state: 'minimized' });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await sleep(1000); // lets the window minimize and the page repaint
  }
  await countdown();
  const frame = await toScreen({ type: 'grab' });
  if (!frame?.ok) throw new Error(frame?.error || 'The screen could not be captured. Please try again.');
  return frameToBitmap(frame.dataUrl);
}

async function captureScreen(tab) {
  const desktop = await grabDesktop(tab);
  if (!desktop) return;
  const canvas = new OffscreenCanvas(desktop.width, desktop.height);
  canvas.getContext('2d').drawImage(desktop, 0, 0);
  const { width, height } = desktop;
  desktop.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  await saveCapture(tab, blob, width, height, 1, { desktop: true });
}

// ---- Full page inside the desktop: browser bar, long page, taskbar ----

function pixels(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

function pageWindowMetrics() {
  const { screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight, devicePixelRatio, screen } = window;
  const border = (outerWidth - innerWidth) / 2;
  return {
    x: (screenX - (screen.availLeft || 0) + border) * devicePixelRatio,
    y: (screenY - (screen.availTop || 0) + outerHeight - innerHeight - border) * devicePixelRatio,
  };
}

// Finds where the page sits on the desktop by matching its sharpest details.
function locateView(desktop, view, estimate) {
  if (view.width > desktop.width || view.height > desktop.height) return null;
  const inRange = (p) => p.x >= 0 && p.y >= 0 && p.x + view.width <= desktop.width && p.y + view.height <= desktop.height;
  const guess = { x: Math.round(estimate.x), y: Math.round(estimate.y) };
  const D = pixels(desktop);
  const V = pixels(view);
  const at = (data, width, x, y) => (y * width + x) * 4;

  const details = [];
  for (let y = 8; y < view.height - 8; y += 5) {
    for (let x = 8; x < view.width - 8; x += 5) {
      const i = at(V, view.width, x, y);
      const right = at(V, view.width, x + 4, y);
      const below = at(V, view.width, x, y + 4);
      const edge = Math.abs(V[i] - V[right]) + Math.abs(V[i + 1] - V[right + 1]) + Math.abs(V[i] - V[below]) + Math.abs(V[i + 1] - V[below + 1]);
      if (edge > 90) details.push({ x, y, r: V[i], g: V[i + 1], b: V[i + 2] });
    }
  }
  if (details.length < 40) return inRange(guess) ? guess : null; // a nearly blank page has nothing to match

  const step = Math.max(1, Math.floor(details.length / 500));
  const points = details.filter((_, i) => i % step === 0);
  const allowedMisses = Math.floor(points.length * 0.4);
  let best = null;
  let fewest = allowedMisses + 1;
  const search = (minX, maxX, minY, maxY) => {
    for (let y = Math.max(0, minY); y <= Math.min(maxY, desktop.height - view.height); y++) {
      for (let x = Math.max(0, minX); x <= Math.min(maxX, desktop.width - view.width); x++) {
        let misses = 0;
        for (const p of points) {
          const i = at(D, desktop.width, x + p.x, y + p.y);
          if (Math.abs(D[i] - p.r) > 28 || Math.abs(D[i + 1] - p.g) > 28 || Math.abs(D[i + 2] - p.b) > 28) {
            misses += 1;
            if (misses >= fewest) break;
          }
        }
        if (misses < fewest) {
          fewest = misses;
          best = { x, y };
        }
      }
    }
  };
  search(guess.x - 60, guess.x + 60, guess.y - 60, guess.y + 60); // usually right here
  if (!best || fewest > points.length * 0.15) search(0, desktop.width, 0, desktop.height);
  return best;
}

function composeDesktopPage(desktop, shot, viewAt) {
  const left = viewAt.x + shot.sx;
  const top = viewAt.y + shot.sy;
  const bottom = top + shot.frameHeight;
  const extra = shot.bitmap.height - shot.frameHeight;
  const canvas = new OffscreenCanvas(desktop.width, desktop.height + extra);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(desktop, 0, 0, desktop.width, bottom, 0, 0, desktop.width, bottom);
  ctx.drawImage(desktop, 0, bottom - 1, desktop.width, 1, 0, bottom, desktop.width, extra); // extends what is beside the page
  ctx.drawImage(desktop, 0, bottom, desktop.width, desktop.height - bottom, 0, bottom + extra, desktop.width, desktop.height - bottom);
  ctx.drawImage(shot.bitmap, left, top);
  return { canvas, headerHeight: top, footerHeight: desktop.height - bottom };
}

// Used if the page cannot be found on the desktop: the full desktop, then the page.
function stackDesktopAbovePage(desktop, shot) {
  const scale = desktop.width / shot.bitmap.width;
  const pageHeight = Math.round(shot.bitmap.height * scale);
  const canvas = new OffscreenCanvas(desktop.width, Math.min(MAX_HEIGHT_PX + desktop.height, desktop.height + pageHeight));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(desktop, 0, 0);
  ctx.drawImage(shot.bitmap, 0, desktop.height, desktop.width, pageHeight);
  return canvas;
}

async function captureFullWithDesktop(tab) {
  const desktop = await grabDesktop(tab);
  if (!desktop) return;
  const view = await frameToBitmap(await captureTab(tab.windowId));
  const estimate = await inPage(tab.id, pageWindowMetrics);
  const viewAt = locateView(desktop, view, estimate);
  view.close();
  await sleep(CAPTURE_GAP_MS);
  const shot = await stitchFullPage(tab);
  const composed = viewAt ? composeDesktopPage(desktop, shot, viewAt) : { canvas: stackDesktopAbovePage(desktop, shot), headerHeight: 0, footerHeight: 0 };
  const { canvas, headerHeight, footerHeight } = composed;
  const screenHeight = viewAt ? desktop.height : 0;
  shot.bitmap.close();
  desktop.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  await saveCapture(tab, blob, canvas.width, canvas.height, 1, {
    desktop: true,
    truncated: shot.truncated,
    panelOnly: !shot.isRoot,
    desktopSeparate: !viewAt,
    headerHeight, // the rows above the page: browser bar
    footerHeight, // the rows below the page: window edge and taskbar
    screenHeight, // the height of the screen, for splitting by screen
  });
}

let capturing = false;

async function capture(mode, tab) {
  if (capturing) throw new Error('A capture is already in progress.');
  capturing = true;
  try {
    await captureMode(mode, tab);
  } finally {
    capturing = false;
  }
}

async function captureMode(mode, tab) {
  if (mode === 'full') {
    const { includeDesktop = false } = await chrome.storage.local.get('includeDesktop');
    await (includeDesktop ? captureFullWithDesktop(tab) : captureFull(tab));
  } else if (mode === 'screen') await captureScreen(tab);
  else {
    // With the taskbar option on, the visible area is taken from the screen, so the
    // browser bar and the taskbar with the clock are kept.
    const { includeDesktop = false } = await chrome.storage.local.get('includeDesktop');
    await (includeDesktop ? captureScreen(tab) : captureVisible(tab));
  }
}

async function reportFailure(error) {
  await chrome.action.setBadgeBackgroundColor({ color: '#d1242f' });
  await chrome.action.setBadgeText({ text: '!' });
  await chrome.action.setTitle({ title: friendlyError(error) });
  await chrome.storage.session.set({ lastError: friendlyError(error) });
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    await capture({ 'capture-full': 'full', 'capture-screen': 'screen' }[command] || 'visible', tab);
  } catch (error) {
    await reportFailure(error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'screen') return false;
  if (message.type === 'screen-picked') {
    onScreenPicked(message, sender.tab?.windowId);
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'screen-status') {
    screenIsShared().then((active) => sendResponse({ active }));
    return true;
  }
  if (message.type === 'screen-stop') {
    toScreen({ type: 'stop' }).catch(() => {}).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'refresh-badge') {
    refreshBadge().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'capture') {
    chrome.tabs.get(message.tabId)
      .then((tab) => capture(message.mode, tab))
      .then(() => sendResponse({ ok: true }))
      .catch(async (error) => {
        if (message.popupClosing) await reportFailure(error);
        else await refreshBadge();
        sendResponse({ ok: false, error: friendlyError(error) });
      });
    return true;
  }
  return false;
});
