import type {
  ActionResponse,
  BackgroundMessage,
  ContentScriptMessage,
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

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener(
  (message: ContentScriptMessage | PopupMessage, sender, sendResponse) => {
    console.log('[Service Worker] Received message:', message.type, 'from', sender.url);

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
