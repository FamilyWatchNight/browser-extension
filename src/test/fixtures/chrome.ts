import { vi } from 'vitest';

type MessageListener = (
  message: { type: string; [key: string]: unknown },
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => unknown;

type PortFixture = {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
  onDisconnect: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
};

type PortMessage = { type: string; [key: string]: unknown };

export function createChromeFixture() {
  const messageListeners: MessageListener[] = [];
  const connectListeners: Array<(port: PortFixture) => unknown> = [];
  const portMessageListeners: Array<(message: PortMessage) => unknown> = [];
  const portDisconnectListeners: Array<() => unknown> = [];
  const debuggerEventListeners: Array<
    (source: { tabId?: number }, method: string, params?: object) => unknown
  > = [];
  const sessionStorage: Record<string, unknown> = {};
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const port: PortFixture = {
    name: 'popup-port',
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: vi.fn((listener: (message: PortMessage) => unknown) => {
        portMessageListeners.push(listener);
      }),
      removeListener: vi.fn(),
    },
    onDisconnect: {
      addListener: vi.fn((listener: () => unknown) => {
        portDisconnectListeners.push(listener);
      }),
      removeListener: vi.fn(),
    },
  };

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      sendMessage,
      connect: vi.fn(() => port),
      onConnect: {
        addListener: vi.fn((listener: (port: PortFixture) => unknown) => {
          connectListeners.push(listener);
        }),
        removeListener: vi.fn(),
      },
      onMessage: {
        addListener: vi.fn((listener: MessageListener) => {
          messageListeners.push(listener);
        }),
        removeListener: vi.fn(),
      },
    },
    storage: {
      session: {
        get: vi.fn(async (keys?: string | string[]) => {
          if (typeof keys === 'string') return { [keys]: sessionStorage[keys] };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, sessionStorage[key]]));
          }
          return { ...sessionStorage };
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionStorage, items);
        }),
      },
      sync: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1, windowId: 1, url: 'http://localhost' }]),
      sendMessage: vi.fn().mockResolvedValue([]),
      executeScript: vi.fn().mockResolvedValue(undefined),
      captureVisibleTab: vi.fn().mockResolvedValue('data:image/jpeg;base64,visible-tab'),
      reload: vi.fn().mockResolvedValue(undefined),
      onRemoved: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    downloads: {
      download: vi.fn().mockResolvedValue(1),
    },
    debugger: {
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn((_debuggee, method: string) =>
        method === 'Network.getResponseBody'
          ? Promise.resolve({
              body: '1\n00:00:01,000 --> 00:00:02,000\nA caption cue',
              base64Encoded: false,
            })
          : Promise.resolve(undefined),
      ),
      onEvent: {
        addListener: vi.fn((listener: (source: { tabId?: number }, method: string, params?: object) => unknown) => {
          debuggerEventListeners.push(listener);
        }),
        removeListener: vi.fn((listener: (source: { tabId?: number }, method: string, params?: object) => unknown) => {
          const index = debuggerEventListeners.indexOf(listener);
          if (index >= 0) debuggerEventListeners.splice(index, 1);
        }),
      },
    },
  };

  return {
    chrome,
    messageListeners,
    connectListeners,
    portMessageListeners,
    portDisconnectListeners,
    debuggerEventListeners,
    sendMessage,
    port,
    sessionStorage,
    reset() {
      messageListeners.length = 0;
      vi.clearAllMocks();
    },
  };
}
