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

export function createChromeFixture() {
  const messageListeners: MessageListener[] = [];
  const connectListeners: Array<(port: PortFixture) => unknown> = [];
  const portMessageListeners: Array<(message: { type: string }) => unknown> = [];
  const portDisconnectListeners: Array<() => unknown> = [];
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const port: PortFixture = {
    name: 'popup-port',
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: vi.fn((listener: (message: { type: string }) => unknown) => {
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
    },
    downloads: {
      download: vi.fn().mockResolvedValue(1),
    },
  };

  return {
    chrome,
    messageListeners,
    connectListeners,
    portMessageListeners,
    portDisconnectListeners,
    sendMessage,
    port,
    reset() {
      messageListeners.length = 0;
      vi.clearAllMocks();
    },
  };
}
