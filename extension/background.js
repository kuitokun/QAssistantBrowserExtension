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
  style.textContent = 'html, body, * { scroll-behavior: auto !important; }';
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
  // Hide the page's own scrollbar only when the page itself scrolls. Otherwise the
  // page would get wider and move sideways behind a pop-up or panel.
  if (state.isRoot) {
    style.textContent += `
      html, body { scrollbar-width: none !important; }
      html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }`;
  }
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

  // A panel or pop-up is captured as real screenshots while it scrolls, so nothing on
  // the page is hidden: each screenshot looks exactly like the screen.
  state.overlays = [];
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
      const tooTall = prep.isRoot
        ? (top + prep.box.height) * scale >= MAX_HEIGHT_PX
        : (frames.length + 1) * bitmap.height > MAX_HEIGHT_PX;
      if (tooTall) {
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

  // For a panel or pop-up: keep every screenshot as it is, one per scroll position.
  const screens = prep.isRoot ? null : frames.map((frame) => frame.bitmap);
  if (prep.isRoot) for (const frame of frames) frame.bitmap.close();
  return {
    bitmap: await createImageBitmap(canvas),
    width, height, scale, sx, sy, frameHeight, truncated, screens,
    isRoot: prep.isRoot,
  };
}

// Puts screenshots one below the other, each exactly as it was on screen.
function stackScreens(images) {
  const width = images[0].width;
  const height = images[0].height;
  const canvas = new OffscreenCanvas(width, height * images.length);
  const ctx = canvas.getContext('2d');
  images.forEach((image, i) => ctx.drawImage(image, 0, i * height));
  return canvas;
}

async function captureFull(tab) {
  await countdown();
  const shot = await stitchFullPage(tab);
  let canvas;
  let layout;
  if (shot.screens) {
    canvas = stackScreens(shot.screens);
    for (const screen of shot.screens) screen.close();
    layout = { stackedScreens: true, screenHeight: canvas.height / shot.screens.length, headerHeight: 0, footerHeight: 0 };
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

// Makes room for an area that grew taller (a panel or pop-up). The page behind it stays
// exactly as it was on screen, down to the bottom of the browser's page area (floor).
// The extra space is added there, at the closest line that crosses nothing, so no field
// is stretched. The area's own box, such as a pop-up's buttons, moves down with it.
function composeStretched(ctx, upper, lower, box, extra) {
  const { left, right, top, bottom } = box;
  const width = upper.width;
  const height = upper.height;
  const end = Math.min(height, Math.max(bottom, box.end || bottom));
  const floor = Math.min(height, Math.max(end, box.floor || height));
  const sides = [[0, left], [right, width]].filter(([from, to]) => to > from);

  // Copies rows [from, to) in columns [x0, x1), moved down by shift. Rows above the area's
  // bottom come from the first screenshot, the rest from the last one.
  const copy = (from, to, shift, x0, x1) => {
    for (const [r0, r1, img] of [[from, Math.min(to, bottom), upper], [Math.max(from, bottom), to, lower]]) {
      if (r1 > r0 && x1 > x0) ctx.drawImage(img, x0, r0, x1 - x0, r1 - r0, x0, r0 + shift, x1 - x0, r1 - r0);
    }
  };
  if (extra <= 0) {
    copy(0, height, 0, 0, width);
    return;
  }

  let split = sides.length ? floor - 1 : end;
  if (sides.length && floor - 1 > top + 1) {
    const from = top + 1;
    const rows = floor - from;
    const probe = new OffscreenCanvas(width, rows);
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    const upTo = Math.min(bottom, floor);
    if (upTo > from) pctx.drawImage(upper, 0, from, width, upTo - from, 0, 0, width, upTo - from);
    if (floor > Math.max(bottom, from)) {
      const start = Math.max(bottom, from);
      pctx.drawImage(lower, 0, start, width, floor - start, 0, start - from, width, floor - start);
    }
    const { data } = pctx.getImageData(0, 0, width, rows);
    const busy = (row) => {
      let changes = 0;
      const offset = row * width * 4;
      for (const [x0, x1] of sides) {
        for (let x = x0 + 1; x < x1; x++) {
          const i = offset + x * 4;
          if (Math.abs(data[i] - data[i - 4]) + Math.abs(data[i + 1] - data[i - 3]) + Math.abs(data[i + 2] - data[i - 2]) > 3) changes++;
        }
      }
      return changes;
    };
    let best = null;
    for (let row = rows - 1; row >= 0; row--) {
      const score = busy(row);
      if (!best || score < best.score) best = { score, row: from + row };
      if (score === 0) break; // the lowest line that crosses nothing
    }
    split = best.row;
  }

  // The page behind, fixed down to the split line, then a plain band, then the rest.
  copy(0, split, 0, 0, width);
  const strip = new OffscreenCanvas(width, 1);
  strip.getContext('2d').drawImage(split < bottom ? upper : lower, 0, split, width, 1, 0, 0, width, 1);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(strip, 0, 0, width, 1, 0, split, width, extra);
  ctx.imageSmoothingEnabled = true;
  copy(split, height, extra, 0, width);
  // The area's own box below the scrolled part (a pop-up's buttons) moves down with it.
  copy(bottom, end, extra, left, right);
}

function composeDesktopPage(desktop, shot, viewAt) {
  const left = viewAt.x + shot.sx;
  const top = viewAt.y + shot.sy;
  const bottom = top + shot.frameHeight;
  const extra = shot.bitmap.height - shot.frameHeight;
  const canvas = new OffscreenCanvas(desktop.width, desktop.height + extra);
  const ctx = canvas.getContext('2d');
  composeStretched(ctx, desktop, desktop, { left, right: left + shot.bitmap.width, top, bottom, end: bottom, floor: bottom }, extra);
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
  let canvas;
  let layout;
  if (shot.screens) {
    // Each scroll position becomes a whole screen: the desktop with that screenshot of the tab in place.
    const screens = viewAt
      ? shot.screens.map((frame) => {
        const screen = new OffscreenCanvas(desktop.width, desktop.height);
        const sctx = screen.getContext('2d');
        sctx.drawImage(desktop, 0, 0);
        sctx.drawImage(frame, viewAt.x, viewAt.y);
        return screen;
      })
      : shot.screens; // the tab couldn't be found on the screen: the tab screenshots alone
    canvas = stackScreens(screens);
    for (const frame of shot.screens) frame.close();
    layout = viewAt
      ? { stackedScreens: true, screenHeight: desktop.height, headerHeight: 0, footerHeight: 0 }
      : { stackedScreens: true, screenHeight: canvas.height / screens.length, headerHeight: 0, footerHeight: 0, desktopSeparate: true };
  } else {
    const composed = viewAt ? composeDesktopPage(desktop, shot, viewAt) : { canvas: stackDesktopAbovePage(desktop, shot), headerHeight: 0, footerHeight: 0 };
    canvas = composed.canvas;
    layout = {
      desktopSeparate: !viewAt,
      headerHeight: composed.headerHeight, // the rows above the page: browser bar
      footerHeight: composed.footerHeight, // the rows below the page: window edge and taskbar
      screenHeight: viewAt ? desktop.height : 0, // the height of the screen, for splitting by screen
    };
  }
  shot.bitmap.close();
  desktop.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  await saveCapture(tab, blob, canvas.width, canvas.height, 1, {
    desktop: true,
    truncated: shot.truncated,
    panelOnly: !shot.isRoot,
    ...layout,
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
