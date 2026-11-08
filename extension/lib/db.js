// All data stays on this computer, in the extension's own IndexedDB database.
const DB_NAME = 'qassistant';
const DB_VERSION = 1;
const META_KEY = 'document';

export const DEFAULT_META = {
  title: 'Test document',
  includeSource: true,
  splitLong: true,
  repeatTaskbar: true,
  splitMode: 'page',
};

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('steps', { keyPath: 'id' });
        db.createObjectStore('meta');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

export async function getMeta() {
  const db = await open();
  const stored = await wrap(db.transaction('meta').objectStore('meta').get(META_KEY));
  return { ...DEFAULT_META, ...stored };
}

export async function setMeta(patch) {
  const db = await open();
  const tx = db.transaction('meta', 'readwrite');
  const store = tx.objectStore('meta');
  const current = await wrap(store.get(META_KEY));
  store.put({ ...DEFAULT_META, ...current, ...patch }, META_KEY);
  await done(tx);
}

export async function listSteps() {
  const db = await open();
  const steps = await wrap(db.transaction('steps').objectStore('steps').getAll());
  return steps.sort((a, b) => a.order - b.order);
}

export async function countSteps() {
  const db = await open();
  return wrap(db.transaction('steps').objectStore('steps').count());
}

export async function getStep(id) {
  const db = await open();
  return wrap(db.transaction('steps').objectStore('steps').get(id));
}

export async function addStep(step) {
  const db = await open();
  const tx = db.transaction('steps', 'readwrite');
  const store = tx.objectStore('steps');
  const all = await wrap(store.getAll());
  const order = all.reduce((max, s) => Math.max(max, s.order), 0) + 1;
  store.put({ ...step, order });
  await done(tx);
  return order;
}

export async function updateStep(id, patch) {
  const db = await open();
  const tx = db.transaction('steps', 'readwrite');
  const store = tx.objectStore('steps');
  const step = await wrap(store.get(id));
  if (step) store.put({ ...step, ...patch });
  await done(tx);
  return Boolean(step);
}

export async function deleteStep(id) {
  const db = await open();
  const tx = db.transaction('steps', 'readwrite');
  tx.objectStore('steps').delete(id);
  await done(tx);
}

export async function clearSteps() {
  const db = await open();
  const tx = db.transaction('steps', 'readwrite');
  tx.objectStore('steps').clear();
  await done(tx);
}

export async function swapOrder(idA, idB) {
  const db = await open();
  const tx = db.transaction('steps', 'readwrite');
  const store = tx.objectStore('steps');
  const a = await wrap(store.get(idA));
  const b = await wrap(store.get(idB));
  if (a && b) {
    store.put({ ...a, order: b.order });
    store.put({ ...b, order: a.order });
  }
  await done(tx);
}
