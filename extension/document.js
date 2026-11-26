import { getMeta, setMeta, listSteps, updateStep, deleteStep, clearSteps, swapOrder } from './lib/db.js';
import * as platform from './platform.js';
import { thumbnail, flatten } from './lib/render.js';
import { buildDocx, docxFilename, fileName } from './lib/docx.js';
import { buildPdf, pdfFilename } from './lib/pdf.js';

const $ = (id) => document.getElementById(id);
const stepsEl = $('steps');
const thumbUrls = new Map();
let meta;
let steps = [];

const debounce = (fn, wait = 300) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
};

function flash(text, keep = false) {
  $('message').textContent = text;
  if (!keep) setTimeout(() => { if ($('message').textContent === text) $('message').textContent = ''; }, 3000);
}

async function thumbFor(step) {
  const key = `${step.id}:${JSON.stringify(step.annotations || [])}`;
  if (!thumbUrls.has(key)) thumbUrls.set(key, URL.createObjectURL(await thumbnail(step)));
  return thumbUrls.get(key);
}

function button(label, onClick, options = {}) {
  const el = document.createElement('button');
  el.textContent = label;
  el.disabled = Boolean(options.disabled);
  if (options.danger) el.className = 'danger';
  el.addEventListener('click', onClick);
  return el;
}

function card(step, index, src) {
  const article = document.createElement('article');
  article.className = 'step';

  const thumb = document.createElement('button');
  thumb.className = 'thumb';
  thumb.title = 'Edit this screenshot';
  const img = document.createElement('img');
  img.src = src;
  img.alt = `Screenshot for step ${index + 1}`;
  thumb.append(img);
  const edit = () => platform.openEditor(step.id);
  thumb.addEventListener('click', edit);

  const side = document.createElement('div');
  const number = document.createElement('div');
  number.className = 'step-num';
  number.textContent = `Step ${index + 1}`;

  const title = document.createElement('input');
  title.type = 'text';
  title.className = 'title';
  title.value = step.title;
  title.placeholder = `Step ${index + 1}`;
  title.setAttribute('aria-label', `Title for step ${index + 1}`);
  title.addEventListener('input', debounce(() => {
    step.title = title.value;
    updateStep(step.id, { title: title.value });
  }));

  const notes = document.createElement('textarea');
  notes.value = step.notes;
  notes.placeholder = 'Notes';
  notes.setAttribute('aria-label', `Notes for step ${index + 1}`);
  notes.addEventListener('input', debounce(() => {
    step.notes = notes.value;
    updateStep(step.id, { notes: notes.value });
  }));

  const source = document.createElement('div');
  source.className = 'source';
  source.textContent = step.url;

  const row = document.createElement('div');
  row.className = 'row';
  row.append(
    button('Edit image', edit),
    button('Move up', () => move(index, -1), { disabled: index === 0 }),
    button('Move down', () => move(index, 1), { disabled: index === steps.length - 1 }),
    button('Delete', async () => {
      if (!confirm(`Delete step ${index + 1}?`)) return;
      await deleteStep(step.id);
      await platform.refreshCount();
      await render();
    }, { danger: true }),
  );

  side.append(number, title, notes, source, row);
  article.append(thumb, side);
  return article;
}

async function move(index, direction) {
  await flushFields();
  await swapOrder(steps[index].id, steps[index + direction].id);
  await render();
}

async function flushFields() {
  await new Promise((resolve) => setTimeout(resolve, 320));
}

async function render() {
  steps = await listSteps();
  $('download').disabled = steps.length === 0;
  document.title = meta.title || 'Test document';
  if (!steps.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No screenshots yet. Go to a page, click the extension icon, and capture it.';
    stepsEl.replaceChildren(empty);
    return;
  }
  const sources = await Promise.all(steps.map(thumbFor));
  stepsEl.replaceChildren(...steps.map((step, i) => card(step, i, sources[i])));
}

const FORMATS = {
  docx: { label: 'Word document', build: buildDocx, name: docxFilename },
  pdf: { label: 'PDF', build: buildPdf, name: pdfFilename },
  png: {
    label: 'Image',
    build: async (_meta, current) => (await flatten(current[0])).convertToBlob({ type: 'image/png' }),
    name: (title) => fileName(title, 'png'),
  },
};

function setMenu(open) {
  $('saveMenu').hidden = !open;
  $('download').setAttribute('aria-expanded', String(open));
  $('save').toggleAttribute('data-open', open);
  if (open) {
    const single = steps.length === 1;
    $('saveImage').disabled = !single;
    $('imageHint').textContent = single ? 'The screenshot with your markup' : 'Only when the document has one screenshot';
    $('saveMenu').querySelector('button:not(:disabled)')?.focus();
  }
}

async function save(format) {
  const { label, build, name } = FORMATS[format];
  setMenu(false);
  const button = $('download');
  button.disabled = true;
  try {
    await flushFields();
    const current = await listSteps();
    if (format === 'png' && current.length !== 1) throw new Error('an image can only be saved when the document has one screenshot');
    const blob = await build(meta, current, (done, total) => flash(`Building the ${label.toLowerCase()}: ${done} of ${total}`, true));
    const saved = await platform.saveFile(blob, name(meta.title));
    flash(saved === false ? 'Download cancelled' : `${label} downloaded`);
  } catch (error) {
    flash(`The ${label.toLowerCase()} could not be built: ${error.message}`, true);
  } finally {
    button.disabled = steps.length === 0;
  }
}

async function init() {
  meta = await getMeta();
  $('docTitle').value = meta.title;
  $('includeSource').checked = meta.includeSource;
  $('splitLong').checked = meta.splitLong;
  $('repeatTaskbar').checked = meta.repeatTaskbar;
  $('repeatTaskbar').disabled = !meta.splitLong;
  $('splitMode').value = meta.splitMode;
  $('splitMode').disabled = !meta.splitLong;
  $('splitMode').addEventListener('change', async () => {
    meta.splitMode = $('splitMode').value;
    await setMeta({ splitMode: meta.splitMode });
  });

  $('docTitle').addEventListener('input', debounce(async () => {
    meta.title = $('docTitle').value;
    document.title = meta.title || 'Test document';
    await setMeta({ title: meta.title });
  }));
  for (const key of ['includeSource', 'splitLong', 'repeatTaskbar']) {
    $(key).addEventListener('change', async () => {
      meta[key] = $(key).checked;
      $('repeatTaskbar').disabled = !meta.splitLong;
      $('splitMode').disabled = !meta.splitLong;
      await setMeta({ [key]: meta[key] });
    });
  }
  $('download').addEventListener('click', () => setMenu($('saveMenu').hidden));
  $('saveMenu').addEventListener('click', (event) => {
    const item = event.target.closest('button[data-format]');
    if (item && !item.disabled) save(item.dataset.format);
  });
  document.addEventListener('click', (event) => {
    if (!$('save').contains(event.target)) setMenu(false);
  });
  $('save').addEventListener('keydown', (event) => {
    const items = [...$('saveMenu').querySelectorAll('button:not(:disabled)')];
    const at = items.indexOf(document.activeElement);
    if (event.key === 'Escape' && !$('saveMenu').hidden) {
      setMenu(false);
      $('download').focus();
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
      event.preventDefault();
      if ($('saveMenu').hidden) return setMenu(true);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length].focus();
    }
  });
  $('newDoc').addEventListener('click', async () => {
    if (!confirm('Start a new document? All current screenshots and notes will be removed. Save it first if you need it.')) return;
    await clearSteps();
    await setMeta({ title: 'Test document' });
    meta = await getMeta();
    $('docTitle').value = meta.title;
    await platform.refreshCount();
    await render();
  });

  // Refresh when coming back from the editor.
  const refreshUnlessTyping = () => {
    if (!document.activeElement?.matches('input, textarea')) render();
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshUnlessTyping();
  });
  window.addEventListener('focus', refreshUnlessTyping);

  await render();
}

init();
