import type {
  ActionResponse,
  AudioCaptureResponse,
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
let activeAudioRecorder: MediaRecorder | undefined;
let activeAudioStream: MediaStream | undefined;
let audioChunks: Blob[] = [];

type CapturableVideo = HTMLVideoElement & {
  captureStream?: () => MediaStream;
};

function getVideoSnapshots(): VideoElement[] {
  return Array.from(detectedVideos.entries())
    .map(([id, video], discoveryIndex) => ({
      video: {
        ...createVideoElementSnapshot(video, 0),
        id,
      },
      discoveryIndex,
    }))
    .sort((left, right) => {
      const leftScore = getVideoPriority(left.video);
      const rightScore = getVideoPriority(right.video);
      return rightScore - leftScore || left.discoveryIndex - right.discoveryIndex;
    })
    .map((entry) => entry.video);
}

function getVideoPriority(video: VideoElement): number {
  const area = video.width * video.height;
  const mediaPriority = video.hasSource ? 1_000_000_000 : 0;
  const readyPriority = video.readyState > 0 ? 100_000_000 : 0;
  const visibilityPriority = video.isVisible ? 10_000_000 : 0;
  const playingPriority = !video.paused ? 1_000_000 : 0;

  return mediaPriority + readyPriority + visibilityPriority + playingPriority + area;
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

      case 'START_AUDIO_CAPTURE':
        handleStartAudioCapture(message.videoId, sendResponse);
        return true;

      case 'STOP_AUDIO_CAPTURE':
        handleStopAudioCapture(sendResponse);
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

  const contentBounds = getScreenshotBounds(video);

  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      sendResponse({ success: false, error: 'Cannot get canvas context', contentBounds });
      return;
    }

    ctx.drawImage(video, 0, 0);
    if (isBlankCanvas(ctx, canvas.width, canvas.height)) {
      sendResponse({
        success: false,
        error: 'Canvas capture returned a blank image',
        contentBounds,
      });
      return;
    }

    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    sendResponse({ success: true, data: dataUrl, contentBounds });
  } catch (e) {
    console.error('Screenshot failed:', e);
    sendResponse({ success: false, error: String(e), contentBounds });
  }
}

function handleStartAudioCapture(
  videoId: string,
  sendResponse: (data: AudioCaptureResponse) => void,
) {
  if (activeAudioRecorder) {
    sendResponse({ success: false, error: 'Audio capture is already active' });
    return;
  }

  const video = detectedVideos.get(videoId);
  if (!video) {
    sendResponse({ success: false, error: 'Video not found' });
    return;
  }

  const capturableVideo = video as CapturableVideo;
  if (!capturableVideo.captureStream) {
    sendResponse({ success: false, error: 'This browser cannot capture media element audio' });
    return;
  }

  try {
    const capturedStream = capturableVideo.captureStream();
    const audioTracks = capturedStream.getAudioTracks();
    if (audioTracks.length === 0) {
      sendResponse({ success: false, error: 'The selected video has no capturable audio track' });
      return;
    }

    const stream = new MediaStream(audioTracks);

    const mimeType = getAudioRecordingMimeType();
    if (!mimeType) {
      sendResponse({ success: false, error: 'This browser cannot encode an audio recording' });
      return;
    }

    audioChunks = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) audioChunks.push(event.data);
    });
    recorder.addEventListener('error', () => {
      stream.getTracks().forEach((track) => track.stop());
      activeAudioRecorder = undefined;
      activeAudioStream = undefined;
      audioChunks = [];
    });
    activeAudioRecorder = recorder;
    activeAudioStream = stream;
    recorder.start();
    sendResponse({ success: true, mimeType });
  } catch (error) {
    activeAudioRecorder = undefined;
    activeAudioStream = undefined;
    audioChunks = [];
    sendResponse({ success: false, error: formatAudioCaptureError(error) });
  }
}

function handleStopAudioCapture(sendResponse: (data: AudioCaptureResponse) => void) {
  const recorder = activeAudioRecorder;
  const stream = activeAudioStream;
  if (!recorder || !stream) {
    sendResponse({ success: false, error: 'Audio capture is not active' });
    return;
  }

  recorder.addEventListener('stop', () => {
    const blob = new Blob(audioChunks, { type: recorder.mimeType });
    const reader = new FileReader();
    reader.addEventListener('loadend', () => {
      stream.getTracks().forEach((track) => track.stop());
      activeAudioRecorder = undefined;
      activeAudioStream = undefined;
      audioChunks = [];
      sendResponse({ success: true, data: String(reader.result), mimeType: recorder.mimeType });
    });
    reader.readAsDataURL(blob);
  });
  recorder.stop();
}

function getAudioRecordingMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function formatAudioCaptureError(error: unknown) {
  if (error instanceof DOMException && error.name === 'SecurityError') {
    return `The selected media is protected or cannot be captured (${error.name}: ${error.message})`;
  }
  if (error instanceof DOMException) {
    return `MediaRecorder failed (${error.name}${error.code ? `, code ${error.code}` : ''}): ${error.message}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function getScreenshotBounds(video: HTMLVideoElement) {
  const rect = video.getBoundingClientRect();
  const aspectRatio = video.videoWidth / video.videoHeight;
  const objectFit = getComputedStyle(video).objectFit;

  if (!aspectRatio || objectFit === 'cover' || objectFit === 'fill') {
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }

  const displayedAspectRatio = rect.width / rect.height;
  const width = displayedAspectRatio > aspectRatio ? rect.height * aspectRatio : rect.width;
  const height = displayedAspectRatio > aspectRatio ? rect.height : rect.width / aspectRatio;

  return {
    x: rect.left + (rect.width - width) / 2,
    y: rect.top + (rect.height - height) / 2,
    width,
    height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

function isBlankCanvas(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const sampleSize = Math.max(1, Math.floor(pixels.length / 4000 / 4));
  let firstRed = 0;
  let firstGreen = 0;
  let firstBlue = 0;
  let hasSample = false;

  for (let pixel = 0; pixel < pixels.length; pixel += sampleSize * 4) {
    const red = pixels[pixel];
    const green = pixels[pixel + 1];
    const blue = pixels[pixel + 2];

    if (!hasSample) {
      firstRed = red;
      firstGreen = green;
      firstBlue = blue;
      hasSample = true;
      continue;
    }

    const brightness = red + green + blue;
    const firstBrightness = firstRed + firstGreen + firstBlue;
    if (brightness > 30 || Math.abs(brightness - firstBrightness) > 12) {
      return false;
    }
  }

  return true;
}

// Start initialization
registerMessageListener();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeContentScript);
} else {
  initializeContentScript();
}
