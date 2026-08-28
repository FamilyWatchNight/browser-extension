import type {
  ActionResponse,
  BackgroundMessage,
  ContentScriptMessage,
  AudioCaptureResponse,
  ExtensionSettings,
  ExtensionState,
  PopupMessage,
  VideoElement,
} from '../../shared/messages';
import { isExtensionSettings } from '../../shared/storage/schema';
import { useExtensionStore } from '../../state/store';

console.log('[Service Worker] Starting...');

// Initialize store on service worker startup
useExtensionStore.getState().loadFromStorage();

const popupPorts = new Set<chrome.runtime.Port>();
let pendingTabCaptureStart: ((response: AudioCaptureResponse) => void) | undefined;
let pendingTabCaptureStop: ((response: AudioCaptureResponse) => void) | undefined;

type OffscreenMessage =
  | { target: 'background'; type: 'TAB_AUDIO_CAPTURE_STARTED'; mimeType: string }
  | { target: 'background'; type: 'TAB_AUDIO_CAPTURE_ERROR'; error: string }
  | { target: 'background'; type: 'TAB_AUDIO_CAPTURE_COMPLETE'; data: string; mimeType: string };

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener(
  (message: ContentScriptMessage | PopupMessage | OffscreenMessage, sender, sendResponse) => {
    console.log('[Service Worker] Received message:', message.type, 'from', sender.url);

    if ('target' in message && message.target === 'background') {
      handleOffscreenMessage(message);
      return false;
    }

    switch (message.type) {
      case 'GET_VIDEO_ELEMENTS':
        if (sender.tab?.id) {
          handleGetVideoElements(sender.tab?.id, sendResponse);
        }
        return true;
      case 'UPDATE_SETTINGS':
        handleUpdateSettings(message.settings, sendResponse);
        return true;

      case 'REQUEST_STATE':
        handleRequestState(sendResponse);
        return true;

      case 'START_TAB_AUDIO_CAPTURE':
        handleStartTabAudioCapture(message.tabId, sendResponse);
        return true;

      case 'STOP_TAB_AUDIO_CAPTURE':
        pendingTabCaptureStop = sendResponse;
        chrome.runtime
          .sendMessage({ target: 'offscreen', type: 'STOP_TAB_AUDIO_CAPTURE' })
          .catch((error) => {
            pendingTabCaptureStop?.({ success: false, error: formatTabCaptureError(error) });
            pendingTabCaptureStop = undefined;
          });
        return true;

      case 'VIDEO_STATE_UPDATE':
        useExtensionStore.getState().setVideos(message.videos);
        broadcastState();
        sendResponse({ success: true });
        return true;

      default:
        // Forward control messages to content script
        if (sender.tab?.id) {
          chrome.tabs.sendMessage(sender.tab?.id, message, sendResponse);
          return true;
        }
    }
  },
);

// Listen for popup connection (long-lived port)
chrome.runtime.onConnect.addListener((port) => {
  console.log('[Service Worker] Port connected:', port.name);

  if (port.name === 'popup-port') {
    popupPorts.add(port);
    port.onDisconnect.addListener(() => popupPorts.delete(port));

    port.onMessage.addListener((message) => {
      console.log('[Service Worker] Popup message:', message.type);

      if (message.type === 'REQUEST_STATE') {
        port.postMessage({
          type: 'STATE_UPDATED',
          state: useExtensionStore.getState(),
        });
      }
    });

    // Send initial state
    port.postMessage({
      type: 'STATE_UPDATED',
      state: useExtensionStore.getState(),
    });
  }
});

function broadcastState() {
  const state = useExtensionStore.getState();
  popupPorts.forEach((port) => port.postMessage({ type: 'STATE_UPDATED', state }));
}

function handleGetVideoElements(tabId: number, sendResponse: (data: VideoElement[]) => void) {
  if (!tabId) {
    sendResponse([]);
    return;
  }

  chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_ELEMENTS' }, (response) => {
    sendResponse(response || []);
  });
}

function handleUpdateSettings(
  settings: ExtensionSettings,
  sendResponse: (data: ActionResponse) => void,
) {
  if (!isExtensionSettings(settings)) {
    sendResponse({ success: false, error: 'Invalid settings' });
    return;
  }

  useExtensionStore.getState().setSettings(settings);
  chrome.storage.sync.set({ settings });
  sendResponse({ success: true });
}

function handleRequestState(sendResponse: (data: BackgroundMessage | ExtensionState) => void) {
  sendResponse({
    type: 'STATE_UPDATED',
    state: useExtensionStore.getState(),
  });
}

async function handleStartTabAudioCapture(
  tabId: number,
  sendResponse: (data: AudioCaptureResponse) => void,
) {
  try {
    await ensureOffscreenDocument();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    pendingTabCaptureStart = sendResponse;
    await chrome.runtime
      .sendMessage({
        target: 'offscreen',
        type: 'START_TAB_AUDIO_CAPTURE',
        streamId,
      })
      .catch((error) => {
        pendingTabCaptureStart?.({ success: false, error: formatTabCaptureError(error) });
        pendingTabCaptureStart = undefined;
      });
  } catch (error) {
    const formattedError = formatTabCaptureError(error);
    console.error('[Service Worker] Whole-tab capture failed:', formattedError);
    sendResponse({ success: false, error: formattedError });
  }
}

function handleOffscreenMessage(message: OffscreenMessage) {
  if (message.type === 'TAB_AUDIO_CAPTURE_STARTED') {
    pendingTabCaptureStart?.({ success: true, mimeType: message.mimeType });
    pendingTabCaptureStart = undefined;
  } else if (message.type === 'TAB_AUDIO_CAPTURE_ERROR') {
    pendingTabCaptureStart?.({ success: false, error: message.error });
    pendingTabCaptureStart = undefined;
    pendingTabCaptureStop?.({ success: false, error: message.error });
    pendingTabCaptureStop = undefined;
  } else if (message.type === 'TAB_AUDIO_CAPTURE_COMPLETE') {
    pendingTabCaptureStop?.({ success: true, data: message.data, mimeType: message.mimeType });
    pendingTabCaptureStop = undefined;
  }
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (
    contexts.some((context) => context.documentUrl?.endsWith('src/entries/offscreen/index.html'))
  ) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'src/entries/offscreen/index.html',
    reasons: ['USER_MEDIA'],
    justification: 'Record audio from the active tab when media element capture is unavailable',
  });
}

function formatTabCaptureError(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
