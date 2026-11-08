// What the shared editor and document pages need from the browser.

export const refreshCount = () => chrome.runtime.sendMessage({ type: 'refresh-badge' }).catch(() => {});

export const openDocument = () => chrome.tabs.create({ url: 'document.html' });

export const openEditor = (id) => chrome.tabs.create({ url: `editor.html?id=${id}` });

export async function closeEditor(step) {
  const current = await chrome.tabs.getCurrent();
  if (step.tabId) await chrome.tabs.update(step.tabId, { active: true }).catch(() => {});
  await chrome.tabs.remove(current.id);
}

// Saves through the browser's normal download flow, so no permission is needed.
export async function saveDocx(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}
