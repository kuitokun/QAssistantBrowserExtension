// Chrome ties a screen share to the page that opened the chooser, so this
// minimized window holds the stream. Nothing is recorded: one frame is taken
// each time a capture is requested.
const IDLE_LIMIT_MS = 10 * 60 * 1000;
const video = document.getElementById('video');
let stream = null;
let idleTimer = null;

function stopAndClose() {
  clearTimeout(idleTimer);
  if (stream) for (const track of stream.getTracks()) track.stop();
  stream = null;
  window.close();
}

function restartIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopAndClose, IDLE_LIMIT_MS);
}

async function start(streamId) {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: streamId,
        maxWidth: 7680,
        maxHeight: 4320,
        minFrameRate: 5,
        maxFrameRate: 10,
      },
    },
  });
  stream.getVideoTracks()[0].addEventListener('ended', stopAndClose);
  video.srcObject = stream;
  await video.play();
  restartIdleTimer();
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

async function grab() {
  if (!stream) throw new Error('Screen sharing has stopped.');
  restartIdleTimer();
  const canvas = document.createElement('canvas');
  try {
    const bitmap = await withTimeout(new ImageCapture(stream.getVideoTracks()[0]).grabFrame(), 1500);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
  } catch {
    if (!video.videoWidth) throw new Error('The screen image was not ready. Please try again.');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
  }
  return canvas.toDataURL('image/png');
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'screen') return false;
  if (message.type === 'status') {
    sendResponse({ active: Boolean(stream?.active) });
    return false;
  }
  if (message.type === 'stop') {
    sendResponse({ ok: true });
    stopAndClose();
    return false;
  }
  grab()
    .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.desktopCapture.chooseDesktopMedia(['screen'], async (streamId) => {
  const chooserError = chrome.runtime.lastError?.message;
  if (!streamId) {
    await chrome.runtime.sendMessage({ type: 'screen-picked', ok: false, error: chooserError });
    window.close();
    return;
  }
  try {
    await start(streamId);
    await chrome.runtime.sendMessage({ type: 'screen-picked', ok: true });
  } catch (error) {
    await chrome.runtime.sendMessage({ type: 'screen-picked', ok: false, error: error.message });
    window.close();
  }
});
