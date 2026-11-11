import { getMeta, countSteps } from './lib/db.js';

const $ = (id) => document.getElementById(id);
const status = $('status');
const canCaptureScreen = () => chrome.permissions.contains({ permissions: ['desktopCapture'] });

async function refresh() {
  const meta = await getMeta();
  const count = await countSteps();
  $('docTitle').textContent = meta.title;
  $('docCount').textContent = `${count} screenshot${count === 1 ? '' : 's'}`;
  $('download').disabled = count === 0;
  const share = await chrome.runtime.sendMessage({ type: 'screen-status' });
  $('sharing').hidden = !share?.active;
  const { lastError } = await chrome.storage.session.get('lastError');
  if (lastError) {
    status.className = 'error';
    status.textContent = lastError;
    await chrome.storage.session.remove('lastError');
    await chrome.runtime.sendMessage({ type: 'refresh-badge' });
  }
}

// Shows the shortcuts the browser actually assigned, which can differ from the suggested ones.
async function showShortcuts() {
  const commands = await chrome.commands.getAll();
  for (const command of commands) {
    const label = document.querySelector(`[data-key="${command.name}"]`);
    if (label) label.textContent = command.shortcut || '';
  }
  const open = commands.find((c) => c.name === '_execute_action')?.shortcut;
  $('openKey').textContent = open ? `${open} opens this menu.` : 'No shortcut opens this menu yet.';
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// The popup closes first, so it stays out of screen captures and the delay can be used.
async function captureAndClose(mode) {
  const tab = await activeTab();
  chrome.runtime.sendMessage({ type: 'capture', mode, tabId: tab.id, popupClosing: true });
  setTimeout(() => window.close(), 60);
}

async function captureHere(mode) {
  const tab = await activeTab();
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  status.className = '';
  status.textContent = mode === 'full'
    ? 'Capturing. The page will scroll by itself, so please stay on it.'
    : 'Capturing…';
  const result = await chrome.runtime.sendMessage({ type: 'capture', mode, tabId: tab.id });
  if (result?.ok) {
    window.close();
    return;
  }
  status.className = 'error';
  status.textContent = result?.error || 'The capture failed.';
  for (const button of document.querySelectorAll('button')) button.disabled = false;
  await refresh();
}

async function askForScreen() {
  await chrome.tabs.create({ url: 'enable-screen.html' });
  window.close();
}

async function capture(mode) {
  const needsScreen = mode === 'screen' || $('includeDesktop').checked;
  if (needsScreen && !(await canCaptureScreen())) return askForScreen();
  if (needsScreen || Number($('delay').value) > 0) return captureAndClose(mode);
  return captureHere(mode);
}

$('full').addEventListener('click', () => capture('full'));
$('visible').addEventListener('click', () => capture('visible'));
$('screen').addEventListener('click', () => capture('screen'));
$('includeDesktop').addEventListener('change', async (event) => {
  if (event.target.checked && !(await canCaptureScreen())) {
    event.target.checked = false;
    await askForScreen();
    return;
  }
  await chrome.storage.local.set({ includeDesktop: event.target.checked });
});
$('scrollUnderMouse').addEventListener('change', (event) => chrome.storage.local.set({ scrollUnderMouse: event.target.checked }));
$('delay').addEventListener('change', (event) => chrome.storage.local.set({ captureDelay: Number(event.target.value) }));
$('stopShare').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'screen-stop' });
  await refresh();
});
$('open').addEventListener('click', () => chrome.tabs.create({ url: 'document.html' }));
$('download').addEventListener('click', () => chrome.tabs.create({ url: 'document.html' }));
$('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

chrome.storage.local.get(['includeDesktop', 'captureDelay', 'scrollUnderMouse']).then(({ includeDesktop = false, captureDelay = 0, scrollUnderMouse = false }) => {
  $('includeDesktop').checked = includeDesktop;
  $('scrollUnderMouse').checked = scrollUnderMouse;
  $('delay').value = String(captureDelay);
});
showShortcuts();
refresh();
