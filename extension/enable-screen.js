document.getElementById('enable').addEventListener('click', async () => {
  const result = document.getElementById('result');
  const granted = await chrome.permissions.request({ permissions: ['desktopCapture'] });
  if (granted) await chrome.storage.local.set({ includeDesktop: true });
  result.textContent = granted
    ? 'Screen capture is on. Go back to your page and click the extension icon.'
    : 'Screen capture stays off. Tab captures still work.';
});
