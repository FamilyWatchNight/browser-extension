import { useEffect, useState } from 'react';

import type { ScreenshotBounds, VideoElement } from '../../shared/messages';
import { connectToServiceWorker } from '../../shared/utils/extension-api';
import { useExtensionStore } from '../../state/store';

export default function PopupApp() {
  const { isEnabled, setEnabled } = useExtensionStore();
  const [localVideos, setLocalVideos] = useState<VideoElement[]>([]);
  const [, setPort] = useState<chrome.runtime.Port | null>(null);

  useEffect(() => {
    // Connect to service worker
    const newPort = connectToServiceWorker('popup-port');
    setPort(newPort);

    newPort.postMessage({ type: 'REQUEST_STATE' });
    newPort.onMessage.addListener((message) => {
      if (message.type === 'STATE_UPDATED') {
        setLocalVideos(message.state.videos);
      }
    });

    // Fetch video elements from active tab
    fetchVideoElements();

    return () => newPort.disconnect();
  }, []);

  async function fetchVideoElements() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_ELEMENTS' });
        const videos = response || [];
        setLocalVideos(videos);
        if (videos.length > 0 || attempt === 3) return;
      } catch (e) {
        if (attempt === 3) {
          console.error('Failed to fetch videos:', e);
          return;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function controlVideo(action: 'play' | 'pause' | 'skip') {
    if (localVideos.length === 0) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    const videoId = localVideos[0].id;

    try {
      if (action === 'play') {
        await chrome.tabs.sendMessage(tab.id, { type: 'PLAY_VIDEO', videoId });
      } else if (action === 'pause') {
        await chrome.tabs.sendMessage(tab.id, { type: 'PAUSE_VIDEO', videoId });
      } else if (action === 'skip') {
        const currentTime = localVideos[0].currentTime + 10;
        await chrome.tabs.sendMessage(tab.id, {
          type: 'MOVE_PLAYHEAD',
          videoId,
          seekTime: currentTime,
        });
      }

      // Refresh video state
      await new Promise((r) => setTimeout(r, 500));
      fetchVideoElements();
    } catch (e) {
      console.error(`Failed to ${action} video:`, e);
    }
  }

  async function captureScreenshot() {
    if (localVideos.length === 0) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    const videoId = localVideos[0].id;

    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'CAPTURE_SCREENSHOT',
        videoId,
      });

      let screenshotData = response.success && response.data ? response.data : undefined;
      if (!screenshotData) {
        const visibleTabData = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: 'jpeg',
          quality: 90,
        });
        screenshotData = await cropTabCapture(visibleTabData, response.contentBounds);
      }
      const timestamp = new Date().toISOString().replace(/[.:]/g, '-');

      await chrome.downloads.download({
        url: screenshotData,
        filename: `screenshot-${timestamp}.jpg`,
        conflictAction: 'uniquify',
        saveAs: false,
      });
    } catch (e) {
      console.error('Failed to capture screenshot:', e);
    }
  }

  async function cropTabCapture(dataUrl: string, bounds?: ScreenshotBounds) {
    if (!bounds) return dataUrl;

    const image = new Image();
    image.src = dataUrl;
    await image.decode();

    const scaleX = image.naturalWidth / bounds.viewportWidth;
    const scaleY = image.naturalHeight / bounds.viewportHeight;
    const x = Math.max(0, Math.round(bounds.x * scaleX));
    const y = Math.max(0, Math.round(bounds.y * scaleY));
    const width = Math.min(image.naturalWidth - x, Math.round(bounds.width * scaleX));
    const height = Math.min(image.naturalHeight - y, Math.round(bounds.height * scaleY));
    if (width <= 0 || height <= 0) return dataUrl;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return dataUrl;

    context.drawImage(image, x, y, width, height, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.9);
  }

  return (
    <div style={{ padding: '16px' }}>
      <h2 style={{ margin: '0 0 16px 0' }}>Virtual Remote Control</h2>

      <div style={{ marginBottom: '16px' }}>
        <label>
          <input
            type="checkbox"
            checked={isEnabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {' Enable'}
        </label>
      </div>

      {localVideos.length > 0 ? (
        <>
          <div style={{ marginBottom: '12px', fontSize: '12px', color: '#666' }}>
            Found {localVideos.length} video(s)
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <button onClick={() => controlVideo('play')} style={{ padding: '8px' }}>
              ▶ Play
            </button>
            <button onClick={() => controlVideo('pause')} style={{ padding: '8px' }}>
              ⏸ Pause
            </button>
            <button onClick={() => controlVideo('skip')} style={{ padding: '8px' }}>
              ⏩ Skip +10s
            </button>
            <button onClick={captureScreenshot} style={{ padding: '8px' }}>
              📸 Screenshot
            </button>
          </div>

          <div style={{ marginTop: '12px', fontSize: '12px' }}>
            <p>
              <strong>Note:</strong> Advanced controls via WebSocket coming in phase 2!
            </p>
          </div>
        </>
      ) : (
        <div style={{ padding: '12px', backgroundColor: '#f0f0f0', borderRadius: '4px' }}>
          No video found on this page. Try navigating to a video streaming site.
        </div>
      )}
    </div>
  );
}
