import type {
  ActionResponse,
  ContentScriptMessage,
  ScreenshotResponse,
  VideoElement,
} from '../../shared/messages';
import { findAllVideos } from '../../shared/utils/dom-query';
import { createVideoElementSnapshot, setupVideoListeners } from '../../shared/utils/video-element';

const detectedVideos: Map<string, HTMLVideoElement> = new Map();
const videoCleanups: Map<HTMLVideoElement, () => void> = new Map();
const documentObservers: Map<Document, MutationObserver> = new Map();
const iframeLoadHandlers: Map<HTMLIFrameElement, () => void> = new Map();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let metadataTimer: ReturnType<typeof setTimeout> | undefined;

function getVideoSnapshots(): VideoElement[] {
  return Array.from(detectedVideos.entries()).map(([id, video]) => ({
    id,
    src: video.src || video.currentSrc,
    title: video.title || document.title || 'Unknown Video',
    duration: video.duration || 0,
    currentTime: video.currentTime || 0,
    paused: video.paused,
    frameIndex: 0,
  }));
}

function scheduleMetadataUpdate() {
  if (metadataTimer !== undefined) return;

  metadataTimer = setTimeout(() => {
    metadataTimer = undefined;
    chrome.runtime
      .sendMessage({ type: 'VIDEO_STATE_UPDATE', videos: getVideoSnapshots() })
      .catch(() => {});
  }, 100);
}

function collectAccessibleDocuments(
  root: Document,
  documents = new Set<Document>(),
): Set<Document> {
  documents.add(root);

  root.querySelectorAll('iframe').forEach((iframe) => {
    try {
      if (iframe.contentDocument) collectAccessibleDocuments(iframe.contentDocument, documents);
    } catch {
      // Cross-origin iframe, skip silently.
    }
  });

  return documents;
}

function syncDocumentObservers() {
  const currentDocuments = collectAccessibleDocuments(document);

  for (const [observedDocument, observer] of documentObservers) {
    if (!currentDocuments.has(observedDocument)) {
      observer.disconnect();
      documentObservers.delete(observedDocument);
    }
  }

  currentDocuments.forEach((observedDocument) => {
    if (!documentObservers.has(observedDocument) && observedDocument.documentElement) {
      const observer = new MutationObserver(() => {
        syncDocumentObservers();
        scheduleRefresh();
      });
      observer.observe(observedDocument.documentElement, { childList: true, subtree: true });
      documentObservers.set(observedDocument, observer);
    }
  });

  const currentIframes = new Set<HTMLIFrameElement>();
  currentDocuments.forEach((observedDocument) => {
    observedDocument.querySelectorAll('iframe').forEach((iframe) => currentIframes.add(iframe));
  });

  for (const [iframe, handler] of iframeLoadHandlers) {
    if (!currentIframes.has(iframe)) {
      iframe.removeEventListener('load', handler);
      iframeLoadHandlers.delete(iframe);
    }
  }

  currentIframes.forEach((iframe) => {
    if (!iframeLoadHandlers.has(iframe)) {
      const handler = () => {
        syncDocumentObservers();
        scheduleRefresh();
      };
      iframe.addEventListener('load', handler);
      iframeLoadHandlers.set(iframe, handler);
    }
  });
}

function refreshDetectedVideos() {
  const videos = findAllVideos();
  const currentVideos = new Set(videos);

  for (const [id, video] of detectedVideos) {
    if (!currentVideos.has(video) || !video.isConnected) {
      detectedVideos.delete(id);
      videoCleanups.get(video)?.();
      videoCleanups.delete(video);
    }
  }

  videos.forEach((video) => {
    if (![...detectedVideos.values()].includes(video)) {
      const snapshot = createVideoElementSnapshot(video, 0);
      detectedVideos.set(snapshot.id, video);
      videoCleanups.set(video, setupVideoListeners(video, scheduleMetadataUpdate));
    }
  });
}

function scheduleRefresh() {
  if (refreshTimer !== undefined) return;

  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    syncDocumentObservers();
    refreshDetectedVideos();
  }, 100);
}

function registerMessageListener() {
  chrome.runtime.onMessage.addListener((message: ContentScriptMessage, _sender, sendResponse) => {
    console.log('[Content Script] Received message:', message.type);

    switch (message.type) {
      case 'GET_VIDEO_ELEMENTS':
        refreshDetectedVideos();
        handleGetVideoElements(sendResponse);
        return true;

      case 'PLAY_VIDEO':
        handlePlayVideo(message.videoId, sendResponse);
        return true;

      case 'PAUSE_VIDEO':
        handlePauseVideo(message.videoId, sendResponse);
        return true;

      case 'MOVE_PLAYHEAD':
        handleMovePlayhead(message.videoId, message.seekTime, sendResponse);
        return true;

      case 'CAPTURE_SCREENSHOT':
        handleCaptureScreenshot(message.videoId, sendResponse);
        return true;

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  });
}

function initializeContentScript() {
  console.log('[Content Script] Initializing...');

  refreshDetectedVideos();
  console.log(`[Content Script] Found ${detectedVideos.size} video elements`);
  syncDocumentObservers();
}

function handleGetVideoElements(sendResponse: (data: VideoElement[]) => void) {
  sendResponse(getVideoSnapshots());
}

function handlePlayVideo(videoId: string, sendResponse: (data: ActionResponse) => void) {
  const video = detectedVideos.get(videoId);
  if (video) {
    video.play().catch((e) => console.error('Play failed:', e));
    sendResponse({ success: true });
  } else {
    sendResponse({ success: false, error: 'Video not found' });
  }
}

function handlePauseVideo(videoId: string, sendResponse: (data: ActionResponse) => void) {
  const video = detectedVideos.get(videoId);
  if (video) {
    video.pause();
    sendResponse({ success: true });
  } else {
    sendResponse({ success: false, error: 'Video not found' });
  }
}

function handleMovePlayhead(
  videoId: string,
  seekTime: number,
  sendResponse: (data: ActionResponse) => void,
) {
  const video = detectedVideos.get(videoId);
  if (video) {
    video.currentTime = seekTime;
    sendResponse({ success: true });
  } else {
    sendResponse({ success: false, error: 'Video not found' });
  }
}

function handleCaptureScreenshot(
  videoId: string,
  sendResponse: (data: ScreenshotResponse) => void,
) {
  const video = detectedVideos.get(videoId);
  if (!video) {
    sendResponse({ success: false, error: 'Video not found' });
    return;
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      sendResponse({ success: false, error: 'Cannot get canvas context' });
      return;
    }

    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    sendResponse({ success: true, data: dataUrl });
  } catch (e) {
    console.error('Screenshot failed:', e);
    sendResponse({ success: false, error: String(e) });
  }
}

// Start initialization
registerMessageListener();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeContentScript);
} else {
  initializeContentScript();
}
