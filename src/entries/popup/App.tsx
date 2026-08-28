import { useCallback, useEffect, useState } from 'react';

import type { ScreenshotBounds, VideoElement } from '../../shared/messages';
import { connectToServiceWorker } from '../../shared/utils/extension-api';
import { useExtensionStore } from '../../state/store';

export default function PopupApp() {
  const { isEnabled, setEnabled } = useExtensionStore();
  const [localVideos, setLocalVideos] = useState<VideoElement[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<string | undefined>();
  const [audioCaptureActive, setAudioCaptureActive] = useState(false);
  const [audioCaptureMode, setAudioCaptureMode] = useState<'video' | 'tab' | undefined>();
  const [audioCaptureError, setAudioCaptureError] = useState<string | undefined>();
  const [, setPort] = useState<chrome.runtime.Port | null>(null);

  const updateVideos = useCallback((videos: VideoElement[]) => {
    setLocalVideos(videos.map(normalizeVideo));
    setSelectedVideoId((currentId) =>
      currentId && videos.some((video) => video.id === currentId) ? currentId : videos[0]?.id,
    );
  }, []);

  function normalizeVideo(video: VideoElement): VideoElement {
    return {
      ...video,
      width: Number.isFinite(video.width) ? video.width : 0,
      height: Number.isFinite(video.height) ? video.height : 0,
      isVisible: video.isVisible ?? false,
      hasSource: video.hasSource ?? Boolean(video.src),
      readyState: Number.isFinite(video.readyState) ? video.readyState : 0,
    };
  }

  const fetchVideoElements = useCallback(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_ELEMENTS' });
        const videos = response || [];
        updateVideos(videos);
        if (videos.length > 0 || attempt === 3) return;
      } catch (e) {
        if (attempt === 3) {
          console.error('Failed to fetch videos:', e);
          return;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }, [updateVideos]);

  useEffect(() => {
    const newPort = connectToServiceWorker('popup-port');
    setPort(newPort);

    newPort.postMessage({ type: 'REQUEST_STATE' });
    newPort.onMessage.addListener((message) => {
      if (message.type === 'STATE_UPDATED') {
        updateVideos(message.state.videos);
      }
    });

    fetchVideoElements();

    return () => newPort.disconnect();
  }, [fetchVideoElements, updateVideos]);

  async function controlVideo(action: 'play' | 'pause' | 'skip') {
    const selectedVideo = localVideos.find((video) => video.id === selectedVideoId);
    if (!selectedVideo) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    const videoId = selectedVideo.id;

    try {
      if (action === 'play') {
        await chrome.tabs.sendMessage(tab.id, { type: 'PLAY_VIDEO', videoId });
      } else if (action === 'pause') {
        await chrome.tabs.sendMessage(tab.id, { type: 'PAUSE_VIDEO', videoId });
      } else if (action === 'skip') {
        const currentTime = selectedVideo.currentTime + 10;
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
    const selectedVideo = localVideos.find((video) => video.id === selectedVideoId);
    if (!selectedVideo) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    const videoId = selectedVideo.id;

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

  async function toggleAudioCapture() {
    const selectedVideo = localVideos.find((video) => video.id === selectedVideoId);
    if (!audioCaptureActive && !selectedVideo) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    try {
      if (!audioCaptureActive) {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'START_AUDIO_CAPTURE',
          videoId: selectedVideo!.id,
        });
        if (!response.success) {
          setAudioCaptureError(response.error || 'Unable to start audio capture');
          return;
        }
        setAudioCaptureError(undefined);
        setAudioCaptureActive(true);
        setAudioCaptureMode('video');
        return;
      }

      const response =
        audioCaptureMode === 'tab'
          ? await chrome.runtime.sendMessage({ type: 'STOP_TAB_AUDIO_CAPTURE' })
          : await chrome.tabs.sendMessage(tab.id, { type: 'STOP_AUDIO_CAPTURE' });
      setAudioCaptureActive(false);
      setAudioCaptureMode(undefined);
      if (!response?.success || !response.data) {
        setAudioCaptureError(response?.error || 'Unable to finish audio capture');
        return;
      }

      const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
      const extension = response.mimeType?.includes('ogg') ? 'ogg' : 'webm';
      await chrome.downloads.download({
        url: response.data,
        filename: `family-watch-night-audio-${timestamp}.${extension}`,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      setAudioCaptureError(undefined);
    } catch (error) {
      setAudioCaptureError(error instanceof Error ? error.message : String(error));
    }
  }

  async function captureWholeTabAudio() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'START_TAB_AUDIO_CAPTURE',
        tabId: tab.id,
      });
      if (!response?.success) {
        setAudioCaptureError(response?.error || 'Unable to start whole-tab capture');
        return;
      }
      setAudioCaptureError(undefined);
      setAudioCaptureActive(true);
      setAudioCaptureMode('tab');
    } catch (error) {
      setAudioCaptureError(error instanceof Error ? error.message : String(error));
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

          {localVideos.length > 1 && (
            <div role="radiogroup" aria-label="Detected videos" style={{ marginBottom: '12px' }}>
              {localVideos.map((video, index) => {
                const isSelected = video.id === selectedVideoId;
                const sourceStatus = video.hasSource ? 'source' : 'no source';
                const playbackStatus = video.paused ? 'paused' : 'playing';

                return (
                  <button
                    key={video.id}
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => setSelectedVideoId(video.id)}
                    style={{
                      display: 'block',
                      width: '100%',
                      marginBottom: '6px',
                      padding: '8px',
                      textAlign: 'left',
                      border: isSelected ? '2px solid #2563eb' : '1px solid #ccc',
                      backgroundColor: isSelected ? '#eff6ff' : '#fff',
                      borderRadius: '4px',
                    }}
                  >
                    <strong>Video {index + 1}</strong>
                    <span style={{ display: 'block', fontSize: '11px', color: '#666' }}>
                      {Math.round(video.width)} x {Math.round(video.height)} px | {sourceStatus} |{' '}
                      {video.isVisible ? 'visible' : 'hidden'} | {playbackStatus}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

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
            <button onClick={toggleAudioCapture} style={{ padding: '8px' }}>
              {audioCaptureActive ? '⏹ Stop audio' : '🎙 Record audio'}
            </button>
          </div>

          {audioCaptureActive && (
            <div role="status" style={{ marginTop: '12px', fontSize: '12px' }}>
              {audioCaptureMode === 'tab'
                ? 'Recording all audio from this tab...'
                : 'Recording audio from the selected video...'}
            </div>
          )}
          {audioCaptureError && (
            <>
              <div role="alert" style={{ marginTop: '12px', fontSize: '12px', color: '#b91c1c' }}>
                {audioCaptureError}
              </div>
              {!audioCaptureActive && (
                <button onClick={captureWholeTabAudio} style={{ marginTop: '8px', padding: '8px' }}>
                  Record whole tab instead
                </button>
              )}
            </>
          )}

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
