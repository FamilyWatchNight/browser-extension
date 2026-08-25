import { vi } from 'vitest'

// Mock Chrome API
const mockChrome = {
  runtime: {
    id: 'mock-extension-id',
    sendMessage: vi.fn().mockResolvedValue({}),
    connect: vi.fn(() => ({
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    })),
    onMessage: {
      addListener: vi.fn(),
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
    query: vi.fn().mockResolvedValue([{ id: 1, url: 'http://localhost' }]),
    sendMessage: vi.fn().mockResolvedValue({}),
    executeScript: vi.fn().mockResolvedValue(undefined),
  },
}

Object.defineProperty(window, 'chrome', {
  value: mockChrome,
  writable: true,
})

export { mockChrome }

