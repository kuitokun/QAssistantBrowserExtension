import { getStep, updateStep, deleteStep, listSteps } from './lib/db.js';
import * as platform from './platform.js';
import { COLORS, drawAnnotations, measureText, strokeWidth } from './lib/render.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const stage = $('stage');
const textInput = $('textInput');
const stepId = new URLSearchParams(location.search).get('id');

let step;
let bitmap;
let annotations = [];
let history = [];
let future = [];
let selectedId = null;
let tool = 'select';
let zoom = 1;
let fitWidth = 0;
let gesture = null; // the current drag
let editingId = null; // the note being typed
let saveTimer = null;
let frame = null;

const toolColors = { highlight: '#facc15', box: '#e5262b', arrow: '#e5262b', text: '#e5262b' };
let textSize = 'm';

const isRect = (a) => a.type === 'highlight' || a.type === 'box' || a.type === 'redact';
const selected = () => annotations.find((a) => a.id === selectedId) || null;
const newId = () => crypto.randomUUID();
const snapshot = () => JSON.stringify(annotations);

// ---- Saving ----

function markUnsaved() {
  $('saved').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 350);
}

async function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  await updateStep(stepId, {
    annotations: annotations.map((a) => ({ ...a })),
    title: $('title').value,
    notes: $('notes').value,
  });
  $('saved').textContent = 'Saved';
}

window.addEventListener('pagehide', () => {
  if (saveTimer) save();
});

// ---- Drawing ----

function requestDraw() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    draw();
  });
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  drawAnnotations(ctx, annotations.filter((a) => a.id !== editingId), canvas.width);
  const a = selected();
  if (a) drawSelection(a);
}

function viewScale() {
  return canvas.width / (fitWidth * zoom);
}

function bounds(a) {
  if (a.type === 'arrow') {
    return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
  }
  if (a.type === 'text') {
    const m = measureText(ctx, a, canvas.width);
    return { x: a.x, y: a.y, w: m.w, h: m.h };
  }
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}

function handlesFor(a) {
  if (a.type === 'arrow') return [{ id: 'start', x: a.x1, y: a.y1 }, { id: 'end', x: a.x2, y: a.y2 }];
  if (!isRect(a)) return [];
  return [
    { id: 'nw', x: a.x, y: a.y },
    { id: 'ne', x: a.x + a.w, y: a.y },
    { id: 'sw', x: a.x, y: a.y + a.h },
    { id: 'se', x: a.x + a.w, y: a.y + a.h },
  ];
}

function drawSelection(a) {
  const scale = viewScale();
  const b = bounds(a);
  ctx.save();
  ctx.strokeStyle = '#1f6feb';
  ctx.lineWidth = 1.5 * scale;
  ctx.setLineDash([6 * scale, 4 * scale]);
  if (a.type !== 'arrow') ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  ctx.fillStyle = '#fff';
  for (const h of handlesFor(a)) {
    ctx.beginPath();
    ctx.arc(h.x, h.y, 6 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// ---- Toolbar state ----

function refreshToolbar() {
  for (const button of document.querySelectorAll('[data-tool]')) {
    button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
  }
  const a = selected();
  const active = a?.type === 'redact' ? null : a?.color || toolColors[tool];
  $('colors').hidden = !active;
  for (const swatch of $('colors').children) {
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color === active));
  }
  const showSizes = tool === 'text' || a?.type === 'text';
  $('sizes').hidden = !showSizes;
  const size = a?.type === 'text' ? a.size : textSize;
  for (const button of $('sizes').children) {
    button.setAttribute('aria-pressed', String(button.dataset.size === size));
  }
  $('undo').disabled = history.length === 0;
  $('redo').disabled = future.length === 0;
  $('remove').disabled = !a;
  canvas.style.cursor = tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair';
}

function setTool(next) {
  commitText();
  tool = next;
  if (next !== 'select') selectedId = null;
  refreshToolbar();
  requestDraw();
}

function pushHistory(before) {
  history.push(before);
  if (history.length > 100) history.shift();
  future = [];
  markUnsaved();
  refreshToolbar();
}

function restore(list, target) {
  target.push(snapshot());
  annotations = JSON.parse(list.pop());
  if (!selected()) selectedId = null;
  markUnsaved();
  refreshToolbar();
  requestDraw();
}

function changeSelected(change) {
  const a = selected();
  if (!a) return false;
  const before = snapshot();
  change(a);
  pushHistory(before);
  requestDraw();
  return true;
}

function removeSelected() {
  if (!selected()) return;
  const before = snapshot();
  annotations = annotations.filter((a) => a.id !== selectedId);
  selectedId = null;
  pushHistory(before);
  requestDraw();
}

// ---- Pointer handling ----

function toImage(event) {
  const rect = canvas.getBoundingClientRect();
  const scale = canvas.width / rect.width;
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * scale)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * scale)),
  };
}

function distanceToSegment(p, a) {
  const dx = a.x2 - a.x1;
  const dy = a.y2 - a.y1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x1) * dx + (p.y - a.y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x1 + t * dx), p.y - (a.y1 + t * dy));
}

function hit(a, p) {
  const tolerance = 8 * viewScale() + strokeWidth(canvas.width) / 2;
  if (a.type === 'arrow') return distanceToSegment(p, a) <= tolerance;
  const b = bounds(a);
  const inside = p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  if (a.type !== 'box') return inside;
  const near = p.x >= b.x - tolerance && p.x <= b.x + b.w + tolerance && p.y >= b.y - tolerance && p.y <= b.y + b.h + tolerance;
  const deep = p.x > b.x + tolerance && p.x < b.x + b.w - tolerance && p.y > b.y + tolerance && p.y < b.y + b.h - tolerance;
  return near && !deep;
}

function topmostAt(p) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (hit(annotations[i], p)) return annotations[i];
  }
  return null;
}

function handleAt(a, p) {
  const reach = 11 * viewScale();
  return handlesFor(a).find((h) => Math.hypot(h.x - p.x, h.y - p.y) <= reach) || null;
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const hadText = editingId !== null;
  commitText();
  const p = toImage(event);
  canvas.setPointerCapture(event.pointerId);

  if (tool === 'select') {
    const current = selected();
    const handle = current && handleAt(current, p);
    if (handle) {
      gesture = { kind: 'resize', id: current.id, handle: handle.id, before: snapshot(), origin: { ...current } };
      return;
    }
    const target = topmostAt(p);
    selectedId = target?.id ?? null;
    refreshToolbar();
    requestDraw();
    if (target) gesture = { kind: 'move', id: target.id, start: p, before: snapshot(), origin: { ...target } };
    return;
  }

  if (tool === 'text') {
    if (hadText) return;
    event.preventDefault();
    gesture = null;
    openTextEditor({ id: newId(), type: 'text', x: p.x, y: p.y, text: '', color: toolColors.text, size: textSize }, true);
    return;
  }

  const shape = tool === 'arrow'
    ? { id: newId(), type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: toolColors.arrow }
    : { id: newId(), type: tool, x: p.x, y: p.y, w: 0, h: 0, color: toolColors[tool] || '#111827' };
  gesture = { kind: 'draw', id: shape.id, start: p, before: snapshot() };
  annotations.push(shape);
}

function onPointerMove(event) {
  if (!gesture) {
    if (tool === 'select') {
      const p = toImage(event);
      const current = selected();
      canvas.style.cursor = current && handleAt(current, p) ? 'nwse-resize' : topmostAt(p) ? 'move' : 'default';
    }
    return;
  }
  const p = toImage(event);
  const a = annotations.find((item) => item.id === gesture.id);
  if (!a) return;

  if (gesture.kind === 'draw') {
    if (a.type === 'arrow') {
      a.x2 = p.x;
      a.y2 = p.y;
    } else {
      a.x = Math.min(gesture.start.x, p.x);
      a.y = Math.min(gesture.start.y, p.y);
      a.w = Math.abs(p.x - gesture.start.x);
      a.h = Math.abs(p.y - gesture.start.y);
    }
  } else if (gesture.kind === 'move') {
    const dx = p.x - gesture.start.x;
    const dy = p.y - gesture.start.y;
    const o = gesture.origin;
    if (a.type === 'arrow') Object.assign(a, { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy });
    else Object.assign(a, { x: o.x + dx, y: o.y + dy });
    gesture.moved = true;
  } else if (gesture.kind === 'resize') {
    const o = gesture.origin;
    gesture.moved = true;
    if (a.type === 'arrow') {
      if (gesture.handle === 'start') Object.assign(a, { x1: p.x, y1: p.y });
      else Object.assign(a, { x2: p.x, y2: p.y });
    } else {
      const fixedX = gesture.handle.includes('w') ? o.x + o.w : o.x;
      const fixedY = gesture.handle.includes('n') ? o.y + o.h : o.y;
      Object.assign(a, {
        x: Math.min(fixedX, p.x), y: Math.min(fixedY, p.y),
        w: Math.abs(p.x - fixedX), h: Math.abs(p.y - fixedY),
      });
    }
  }
  requestDraw();
}

function onPointerUp() {
  if (!gesture) return;
  const { kind, id, before, moved } = gesture;
  gesture = null;
  const a = annotations.find((item) => item.id === id);
  if (kind === 'draw') {
    const b = a && bounds(a);
    const big = b && (a.type === 'arrow' ? Math.hypot(b.w, b.h) > 8 : b.w > 6 && b.h > 6);
    if (big) {
      pushHistory(before);
    } else {
      annotations = annotations.filter((item) => item.id !== id);
    }
  } else if (moved) {
    pushHistory(before);
  }
  requestDraw();
}

// ---- Text notes ----

function openTextEditor(annotation, isNew) {
  const rect = { left: annotation.x / viewScale(), top: annotation.y / viewScale() };
  editingId = annotation.id;
  textInput.dataset.isNew = isNew ? '1' : '';
  textInput.dataset.before = snapshot();
  if (isNew) annotations.push(annotation);
  textInput.hidden = false;
  textInput.value = annotation.text;
  textInput.style.left = `${rect.left}px`;
  textInput.style.top = `${rect.top}px`;
  textInput.style.width = '300px';
  textInput.style.height = '84px';
  textInput.style.color = '#1b2430';
  requestDraw();
  setTimeout(() => textInput.focus(), 0);
}

function commitText(cancel = false) {
  if (editingId === null) return;
  const id = editingId;
  const a = annotations.find((item) => item.id === id);
  const value = textInput.value.trim();
  const isNew = textInput.dataset.isNew === '1';
  const before = textInput.dataset.before;
  editingId = null;
  textInput.hidden = true;

  if (cancel || !value) {
    if (isNew || !value) annotations = annotations.filter((item) => item.id !== id);
    if (!isNew && !cancel) pushHistory(before);
  } else if (a && a.text !== value) {
    a.text = value;
    selectedId = id;
    pushHistory(before);
    if (tool === 'text') tool = 'select';
  }
  refreshToolbar();
  requestDraw();
}

// ---- Zoom ----

function computeFit() {
  const available = stage.clientWidth - 40;
  fitWidth = Math.min(available, canvas.width / (step.scale || 1));
}

function applyZoom() {
  canvas.style.width = `${Math.round(fitWidth * zoom)}px`;
  $('zoomLabel').textContent = `${Math.round(zoom * 100)}%`;
  requestDraw();
}

function changeZoom(direction) {
  commitText();
  zoom = Math.max(0.5, Math.min(3, Math.round((zoom + direction * 0.25) * 100) / 100));
  applyZoom();
}

// ---- Set up ----

// Makes hidden areas permanent, so the original pixels no longer exist anywhere.
async function burnHiddenAreas() {
  const hidden = annotations.filter((a) => a.type === 'redact');
  if (!hidden.length) return;
  const flat = new OffscreenCanvas(bitmap.width, bitmap.height);
  const flatContext = flat.getContext('2d');
  flatContext.drawImage(bitmap, 0, 0);
  drawAnnotations(flatContext, hidden, bitmap.width);
  const image = await flat.convertToBlob({ type: 'image/png' });
  annotations = annotations.filter((a) => a.type !== 'redact');
  history = [];
  future = [];
  selectedId = null;
  await updateStep(stepId, { image, annotations: annotations.map((a) => ({ ...a })) });
  bitmap.close();
  bitmap = await createImageBitmap(image);
  refreshToolbar();
  requestDraw();
}

async function finish() {
  commitText();
  await save();
  await burnHiddenAreas();
  await platform.refreshCount();
  await platform.closeEditor(step);
}

async function init() {
  step = await getStep(stepId);
  if (!step) {
    const message = document.createElement('p');
    message.style.padding = '24px';
    message.textContent = 'This screenshot is no longer in the document.';
    document.body.replaceChildren(message);
    return;
  }
  bitmap = await createImageBitmap(step.image);
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  annotations = step.annotations || [];

  const all = await listSteps();
  const number = all.findIndex((s) => s.id === stepId) + 1;
  $('stepLabel').textContent = `Step ${number}`;
  document.title = `Edit step ${number}`;
  $('title').placeholder = `Step ${number}, or e.g. Login with a valid user`;
  $('title').value = step.title;
  $('notes').value = step.notes;
  $('source').textContent = step.url;

  const warnings = [];
  if (step.panelOnly) warnings.push('This page scrolls inside a panel or pop-up, so each scroll position was captured as its own screenshot, one below the other.');
  if (step.desktopSeparate) warnings.push('The page could not be matched to the desktop, so they are shown one above the other.');
  if (step.stoppedEarly) warnings.push('Scrolling stopped early because the view moved too far between frames. Capture the rest separately.');
  if (step.truncated) warnings.push('This page is too long for one image, so the end was cut off. Capture the rest separately.');
  if (warnings.length) {
    $('warning').hidden = false;
    $('warning').textContent = warnings.join(' ');
  }

  for (const color of COLORS) {
    const swatch = document.createElement('button');
    swatch.className = 'swatch';
    swatch.dataset.color = color;
    swatch.style.background = color;
    swatch.style.setProperty('--swatch', color);
    swatch.title = 'Change colour';
    swatch.setAttribute('aria-label', `Colour ${color}`);
    swatch.addEventListener('click', () => {
      if (!changeSelected((a) => { if (a.type !== 'redact') a.color = color; })) {
        if (tool in toolColors) toolColors[tool] = color;
      } else if (selected()?.type in toolColors) {
        toolColors[selected().type] = color;
      }
      refreshToolbar();
    });
    $('colors').appendChild(swatch);
  }

  for (const button of document.querySelectorAll('[data-tool]')) {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  }
  for (const button of $('sizes').children) {
    button.addEventListener('click', () => {
      const size = button.dataset.size;
      textSize = size;
      if (selected()?.type === 'text') changeSelected((a) => { a.size = size; });
      refreshToolbar();
    });
  }

  $('undo').addEventListener('click', () => history.length && restore(history, future));
  $('redo').addEventListener('click', () => future.length && restore(future, history));
  $('remove').addEventListener('click', removeSelected);
  $('zoomIn').addEventListener('click', () => changeZoom(1));
  $('zoomOut').addEventListener('click', () => changeZoom(-1));
  $('title').addEventListener('input', markUnsaved);
  $('notes').addEventListener('input', markUnsaved);
  $('done').addEventListener('click', finish);
  $('openDoc').addEventListener('click', async () => {
    commitText();
    await save();
    await burnHiddenAreas();
    await platform.openDocument();
  });
  $('discard').addEventListener('click', async () => {
    if (!confirm('Delete this screenshot from the document?')) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    await deleteStep(stepId);
    await platform.refreshCount();
    await platform.closeEditor(step);
  });

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', (event) => {
    const target = topmostAt(toImage(event));
    if (target?.type === 'text') openTextEditor(target, false);
  });

  textInput.addEventListener('blur', () => commitText());
  textInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') commitText(true);
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) commitText();
  });

  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
    const mod = event.ctrlKey || event.metaKey;
    if (typing) return;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      const list = event.shiftKey ? future : history;
      if (list.length) restore(list, event.shiftKey ? history : future);
    } else if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      if (future.length) restore(future, history);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeSelected();
    } else if (event.key === 'Escape') {
      selectedId = null;
      setTool('select');
    } else if (!mod && !event.altKey) {
      const shortcut = { v: 'select', h: 'highlight', b: 'box', a: 'arrow', t: 'text', r: 'redact' }[event.key.toLowerCase()];
      if (shortcut) setTool(shortcut);
    }
  });

  window.addEventListener('resize', () => {
    computeFit();
    applyZoom();
  });

  computeFit();
  applyZoom();
  setTool('highlight');
  $('title').focus();
}

init();
