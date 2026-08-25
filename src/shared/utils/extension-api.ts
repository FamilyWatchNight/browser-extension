import type {
  BackgroundMessage,
  ContentScriptMessage,
  MessageResponse,
  PopupMessage,
} from '../messages'

export async function sendMessageToContentScript<T extends ContentScriptMessage>(
  tabId: number,
  message: T
): Promise<MessageResponse<T>> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message)
    return response
  } catch (e) {
    console.error('Failed to send message to content script:', e)
    throw e
  }
}

export async function sendMessageToServiceWorker<T extends PopupMessage | ContentScriptMessage>(
  message: T
): Promise<MessageResponse<T>> {
  try {
    const response = await chrome.runtime.sendMessage(message)
    return response
  } catch (e) {
    console.error('Failed to send message to service worker:', e)
    throw e
  }
}

export function connectToServiceWorker(name: string = 'popup-port') {
  return chrome.runtime.connect({ name })
}

export function onServiceWorkerMessage(callback: (message: BackgroundMessage) => void) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    callback(message)
  })
}
