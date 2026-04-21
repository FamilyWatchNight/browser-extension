# Plan: Chrome Extension "Virtual Remote Control" for Video Streaming

## Project Overview

Build a Chrome extension (Manifest V3) that serves as a "Virtual Remote Control" for video streaming services. The extension detects and interacts with video elements across iframes, tracks playback events, and provides controls via a popup UI. Future phases will add WebSocket connection to a localhost service for more sophisticated control.

**Tech Stack**: React 18 + TypeScript + Vite + CRXJS + Zustand + Vitest

**Architecture**: Scalable, modular structure with separate entry points for popup, options page, content scripts, and service worker. Includes testing, linting, and CI/CD from day one.

---

## Functional Requirements

1. **Video Detection**
   - Detect video elements on any webpage
   - Recursively search through same-origin iframes
   - Handle shadow DOMs gracefully
   - Gracefully skip cross-origin iframes (no error to user)

2. **Video Control**
   - Play/Pause video
   - Move playhead (skip forward/backward)
   - Capture screenshot of video content

3. **Event Tracking**
   - Track playback progress (currentTime updates)
   - Detect play/pause events
   - Detect ad events (phase 2)
   - Track captions loading (real-time and bulk)

4. **Settings & Persistence**
   - Screenshot save location configuration
   - Settings persist across browser sessions
   - Settings sync across user's devices via chrome.storage.sync

5. **Future (Phase 2)**
   - WebSocket connection to localhost service
   - Advanced control via external service
   - Ad detection and navigation heuristics
   - Screenshot export/download

---

## Architecture Overview

### Folder Structure

```
chrome-extension/
├── src/
│   ├── manifest.json                          # MV3 manifest
│   ├── entries/
│   │   ├── popup/
│   │   │   ├── index.html
│   │   │   ├── main.tsx
│   │   │   └── App.tsx
│   │   ├── options/
│   │   │   ├── index.html
│   │   │   ├── main.tsx
│   │   │   └── App.tsx
│   │   ├── content-script/
│   │   │   └── index.ts
│   │   └── background/
│   │       └── service-worker.ts
│   ├── shared/
│   │   ├── messages.ts                        # Type-safe message definitions
│   │   ├── storage/
│   │   │   ├── hooks.ts                       # useStorage hook
│   │   │   └── schema.ts                      # Storage type definitions
│   │   ├── ui/
│   │   │   └── components/                    # Shared React components (future)
│   │   └── utils/
│   │       ├── dom-query.ts                   # Video detection across iframes
│   │       ├── video-element.ts               # Video element wrappers
│   │       └── extension-api.ts               # Type-safe messaging helpers
│   ├── state/
│   │   └── store.ts                           # Zustand store with chrome.storage sync
│   ├── styles/
│   │   └── globals.css
│   └── test/
│       ├── setup.ts                           # Mock Chrome APIs
│       └── __tests__/                         # Test files mirror src/ structure
├── public/
│   └── icons/                                 # 16x16, 48x48, 128x128 PNG icons
├── .github/
│   └── workflows/
│       ├── ci.yml                             # Lint, test, build on push/PR
│       └── release.yml                        # Manual version bump + release
├── .gitignore
├── README.md
├── LICENSE
├── package.json
├── vite.config.ts
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js (or .eslintrc.json)
└── .prettierrc.json
```

### Communication Flow

```
Popup/Options Page
    ↓ (chrome.runtime.connect port or sendMessage)
Service Worker
    ↓ (sendMessage to content script)
Content Script (runs in all frames)
    ↓ (querySelector/querySelectorAll on DOM)
Video Element
    ↓ (listen: play, pause, timeupdate events)
Content Script ← → Service Worker ← → Popup
```

### State Management

- **Zustand store** keeps in-memory state (video list, playback progress, settings)
- **chrome.storage.sync** persists settings across browser sessions and devices
- **Storage change listener** syncs storage updates back to Zustand
- **Content script** sends state updates to service worker, which broadcastes to all tabs

---

## Implementation Plan

### Phase 1: Project Initialization & Setup (7 steps)

#### Step 1: Create Folder Structure
- Create directory at `c:\Users\steve\OneDrive\Documents\develop\FamilyWatchNight\chrome-extension`
- Create all subdirectories listed above
- Create empty placeholder files (HTML, TS, React components)

#### Step 2: Initialize Node.js Project
- Run: `npm init -y`
- Install core dependencies:
  ```bash
  npm install react@latest react-dom@latest zustand
  ```
- Install dev dependencies:
  ```bash
  npm install --save-dev \
    typescript vite @vitejs/plugin-react @crxjs/vite-plugin \
    vitest jsdom @vitest/ui @testing-library/react @testing-library/jsdom \
    eslint prettier @typescript-eslint/eslint-plugin @typescript-eslint/parser \
    eslint-plugin-react eslint-plugin-react-hooks
  ```
- Create `tsconfig.json`:
  ```json
  {
    "compilerOptions": {
      "target": "ES2020",
      "useDefineForClassFields": true,
      "lib": ["ES2020", "DOM", "DOM.Iterable"],
      "module": "ESNext",
      "skipLibCheck": true,
      "esModuleInterop": true,
      "allowSyntheticDefaultImports": true,
      "strict": true,
      "resolveJsonModule": true,
      "isolatedModules": true,
      "moduleResolution": "bundler",
      "noEmit": true,
      "jsx": "react-jsx",
      "types": ["vitest/globals"]
    },
    "include": ["src"],
    "references": [{ "path": "./tsconfig.node.json" }]
  }
  ```

#### Step 3: Create Manifest V3

File: `src/manifest.json`

```json
{
  "manifest_version": 3,
  "name": "Family Watch Night - Virtual Remote Control",
  "description": "Control video playback on streaming services",
  "version": "0.1.0",
  "permissions": ["storage", "scripting", "tabs"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "src/entries/background/service-worker.ts"
  },
  "action": {
    "default_popup": "src/entries/popup/index.html",
    "default_title": "Virtual Remote Control"
  },
  "options_page": "src/entries/options/index.html",
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/entries/content-script/index.ts"],
      "run_at": "document_end",
      "all_frames": true
    }
  ],
  "icons": {
    "16": "public/icons/icon-16.png",
    "48": "public/icons/icon-48.png",
    "128": "public/icons/icon-128.png"
  }
}
```

#### Step 4: Configure Vite

File: `vite.config.ts`

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest.json'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: '[name].js',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
})
```

File: `vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
})
```

#### Step 5: Create README.md, LICENSE, and .gitignore

File: `README.md`

```markdown
# Family Watch Night - Chrome Extension

## Virtual Remote Control for Video Streaming Services

A Chrome extension that detects and controls video playback on any streaming service. The extension finds video elements even when buried in iframes, provides playback controls (play/pause/skip), captures screenshots, and tracks playback events.

### Features

- **Automatic Video Detection**: Recursively finds video elements across iframes
- **Playback Controls**: Play, pause, and seek through video content
- **Screenshot Capture**: Take screenshots of video frames
- **Setting Persistence**: User preferences sync across browser sessions and devices
- **Future WebSocket Support**: Connect to localhost service for advanced controls

### Tech Stack

- **Frontend**: React 18, TypeScript
- **Build**: Vite, CRXJS
- **State Management**: Zustand
- **Testing**: Vitest, jsdom
- **Code Quality**: ESLint, Prettier
- **CI/CD**: GitHub Actions

### Quick Start

\`\`\`bash
# Install dependencies
npm install

# Start development server with HMR
npm run dev

# Build for production
npm run build

# Run tests
npm test

# Lint and format code
npm run lint
npm run format
\`\`\`

### Loading in Chrome

1. Run \`npm run build\` to create the \`dist/\` folder
2. Go to \`chrome://extensions/\` in Chrome
3. Enable "Developer mode" (top right toggle)
4. Click "Load unpacked"
5. Select the \`dist/\` folder

### Project Structure

\`\`\`
src/
├── entries/
│   ├── popup/          # Extension popup UI
│   ├── options/        # Settings page
│   ├── content-script/ # Injected into web pages
│   └── background/     # Service worker
├── shared/             # Shared utilities and types
├── state/              # Zustand store
└── test/               # Test utilities and mocks
\`\`\`

### Development Phases

- **Phase 1**: Project setup, basic architecture (current)
- **Phase 2**: Content script & DOM detection
- **Phase 3**: Service worker & message routing
- **Phase 4**: React UI (popup + options)
- **Phase 5**: Testing & code quality
- **Phase 6**: GitHub setup & CI/CD

### License

GNU General Public License v3.0 (GPL-3.0)

See [LICENSE](./LICENSE) for details.
\`\`\`

File: `LICENSE`

The GNU General Public License v3.0 full text. Copy from [https://www.gnu.org/licenses/gpl-3.0.txt](https://www.gnu.org/licenses/gpl-3.0.txt) or use this command:
```bash
curl https://www.gnu.org/licenses/gpl-3.0.txt > LICENSE
```

File: `.gitignore`

```
# Dependencies
node_modules/

# Build output
dist/
build/

# Environment variables
.env
.env.local
.env.*.local

# IDE
.vscode/
.idea/
*.swp
*.swo
*~
.DS_Store

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Testing
.coverage/
.nyc_output/
```

**Manual steps (you will perform):**
- Run: `git init`
- Run: `git add .`
- Run: `git commit -m "Initial commit: baseline project structure"`
- Later: Create GitHub repository and push to origin

#### Step 6: Create Type-Safe Messaging Protocol

File: `src/shared/messages.ts`

```typescript
// Message types sent from content script to background
export type ContentScriptMessage =
  | { type: 'GET_VIDEO_ELEMENTS' }
  | { type: 'PLAY_VIDEO'; videoId: string }
  | { type: 'PAUSE_VIDEO'; videoId: string }
  | { type: 'MOVE_PLAYHEAD'; videoId: string; seekTime: number }
  | { type: 'CAPTURE_SCREENSHOT'; videoId: string }
  | { type: 'VIDEO_STATE_UPDATE'; videos: VideoElement[] }

// Message types sent from popup/options to background
export type PopupMessage =
  | { type: 'UPDATE_SETTINGS'; settings: ExtensionSettings }
  | { type: 'REQUEST_STATE' }

// Message types sent from background to popup/content script
export type BackgroundMessage =
  | { type: 'STATE_UPDATED'; state: ExtensionState }
  | { type: 'SETTINGS_CHANGED'; settings: ExtensionSettings }

// Types for video elements detected
export interface VideoElement {
  id: string // Unique identifier
  src: string // Video source URL
  title: string // Page title or video title
  duration: number // Duration in seconds
  currentTime: number // Current playback position
  paused: boolean // Is playback paused
  frameIndex: number // Which frame (0 = main, 1+ = iframe)
}

export interface ExtensionSettings {
  isEnabled: boolean
  screenshotSaveLocation: string
}

export interface ExtensionState {
  isEnabled: boolean
  videos: VideoElement[]
  playbackState: Record<string, { position: number; isPlaying: boolean }>
  settings: ExtensionSettings
}

// Type helpers for responses
export type MessageResponse<T extends ContentScriptMessage | PopupMessage> =
  T extends { type: 'GET_VIDEO_ELEMENTS' } ? VideoElement[] :
  T extends { type: 'REQUEST_STATE' } ? ExtensionState :
  T extends { type: 'UPDATE_SETTINGS' } ? { success: boolean } :
  T extends { type: 'PLAY_VIDEO' | 'PAUSE_VIDEO' | 'MOVE_PLAYHEAD' } ? { success: boolean } :
  T extends { type: 'CAPTURE_SCREENSHOT' } ? { success: boolean; data?: string } :
  never
```

#### Step 7: Set Up State Management

File: `src/state/store.ts`

```typescript
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/react'
import type { ExtensionSettings, ExtensionState, VideoElement } from '../shared/messages'

const defaultSettings: ExtensionSettings = {
  isEnabled: true,
  screenshotSaveLocation: 'Downloads',
}

const defaultState: ExtensionState = {
  isEnabled: true,
  videos: [],
  playbackState: {},
  settings: defaultSettings,
}

export const useExtensionStore = create(
  subscribeWithSelector((set, get) => ({
    ...defaultState,

    // Settings
    setSettings: (settings: ExtensionSettings) => {
      set({ settings })
      // Sync to chrome.storage.sync
      chrome.storage.sync.set({ settings })
    },

    // Videos
    setVideos: (videos: VideoElement[]) => set({ videos }),

    // Playback state
    updatePlaybackState: (videoId: string, position: number, isPlaying: boolean) => {
      set(state => ({
        playbackState: {
          ...state.playbackState,
          [videoId]: { position, isPlaying },
        },
      }))
    },

    // Enable/disable
    setEnabled: (isEnabled: boolean) => {
      set({ isEnabled })
      chrome.storage.sync.set({ isEnabled })
    },

    // Initialize from storage
    loadFromStorage: async () => {
      const result = await chrome.storage.sync.get(['settings', 'isEnabled'])
      const settings = result.settings || defaultSettings
      const isEnabled = result.isEnabled !== undefined ? result.isEnabled : true
      set({ settings, isEnabled })
    },
  }))
)

// Listen to storage changes across contexts
if (typeof chrome !== 'undefined' && chrome.storage) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') {
      if (changes.settings) {
        useExtensionStore.setState({ settings: changes.settings.newValue })
      }
      if (changes.isEnabled) {
        useExtensionStore.setState({ isEnabled: changes.isEnabled.newValue })
      }
    }
  })
}
```

File: `src/shared/storage/schema.ts`

```typescript
import type { ExtensionSettings } from '../messages'

export interface StorageSchema {
  settings: ExtensionSettings
  isEnabled: boolean
}
```

File: `src/shared/storage/hooks.ts`

```typescript
import { useEffect, useState } from 'react'

export function useStorage<K extends string, V>(key: K, defaultValue: V): [V, (value: V) => void] {
  const [value, setValue] = useState<V>(defaultValue)

  useEffect(() => {
    // Load initial value
    chrome.storage.sync.get([key], result => {
      if (result[key]) {
        setValue(result[key])
      }
    })

    // Subscribe to changes
    const listener = (changes: Record<string, any>) => {
      if (changes[key]) {
        setValue(changes[key].newValue)
      }
    }
    chrome.storage.onChanged.addListener(listener)

    return () => chrome.storage.onChanged.removeListener(listener)
  }, [key])

  const setSyncedValue = (newValue: V) => {
    setValue(newValue)
    chrome.storage.sync.set({ [key]: newValue })
  }

  return [value, setSyncedValue]
}
```

---

### Phase 2: Content Script & DOM Detection (2 steps)

#### Step 8: Implement Video Detection Utility

File: `src/shared/utils/dom-query.ts`

```typescript
export function findAllVideos(root: Document | Element = document): HTMLVideoElement[] {
  const videos: HTMLVideoElement[] = []

  // Find direct video elements
  videos.push(...Array.from(root.querySelectorAll('video')))

  // Recursively search iframes (same-origin only)
  try {
    const iframes = root.querySelectorAll('iframe')
    iframes.forEach(iframe => {
      try {
        if (iframe.contentDocument) {
          videos.push(...findAllVideos(iframe.contentDocument))
        }
      } catch (e) {
        // Cross-origin iframe, skip silently
        console.debug('Skipping cross-origin iframe')
      }
    })
  } catch (e) {
    console.debug('Error searching iframes:', e)
  }

  return videos
}

export function deepQuerySelector(selector: string, root: Document | DocumentFragment | ShadowRoot = document): Element[] {
  const results: Element[] = []

  const walk = (node: any) => {
    try {
      results.push(...node.querySelectorAll(selector))
      // Check shadow DOMs
      node.querySelectorAll('*').forEach((el: Element) => {
        if (el.shadowRoot) {
          walk(el.shadowRoot)
        }
      })
    } catch (e) {
      console.debug('Error in deepQuerySelector:', e)
    }
  }

  walk(root)
  return results
}
```

File: `src/shared/utils/video-element.ts`

```typescript
import type { VideoElement } from '../messages'

export function createVideoElementSnapshot(video: HTMLVideoElement, frameIndex: number = 0): VideoElement {
  return {
    id: `video-${Date.now()}-${Math.random()}`,
    src: video.src || video.currentSrc || (video.querySelector('source') as any)?.src || '',
    title: getVideoTitle(video),
    duration: video.duration || 0,
    currentTime: video.currentTime || 0,
    paused: video.paused,
    frameIndex,
  }
}

function getVideoTitle(video: HTMLVideoElement): string {
  return video.title || document.title || 'Unknown Video'
}

export function setupVideoListeners(video: HTMLVideoElement, onUpdate: (state: any) => void): () => void {
  const updateState = () => {
    onUpdate({
      currentTime: video.currentTime,
      paused: video.paused,
      duration: video.duration,
    })
  }

  video.addEventListener('play', updateState)
  video.addEventListener('pause', updateState)
  video.addEventListener('timeupdate', updateState)
  video.addEventListener('loadedmetadata', updateState)

  return () => {
    video.removeEventListener('play', updateState)
    video.removeEventListener('pause', updateState)
    video.removeEventListener('timeupdate', updateState)
    video.removeEventListener('loadedmetadata', updateState)
  }
}
```

#### Step 9: Scaffold Content Script

File: `src/entries/content-script/index.ts`

```typescript
import { findAllVideos } from '../../shared/utils/dom-query'
import { createVideoElementSnapshot } from '../../shared/utils/video-element'
import type { ContentScriptMessage, VideoElement } from '../../shared/messages'

let detectedVideos: Map<string, HTMLVideoElement> = new Map()

// Initialize on page load
function initializeContentScript() {
  console.log('[Content Script] Initializing...')
  
  const videos = findAllVideos()
  console.log(`[Content Script] Found ${videos.length} video elements`)

  // Create snapshots and listen for updates
  videos.forEach((video, idx) => {
    const snapshot = createVideoElementSnapshot(video, 0)
    detectedVideos.set(snapshot.id, video)
  })

  // Listen for messages from service worker
  chrome.runtime.onMessage.addListener((message: ContentScriptMessage, sender, sendResponse) => {
    console.log('[Content Script] Received message:', message.type)

    switch (message.type) {
      case 'GET_VIDEO_ELEMENTS':
        handleGetVideoElements(sendResponse)
        return true

      case 'PLAY_VIDEO':
        handlePlayVideo(message.videoId, sendResponse)
        return true

      case 'PAUSE_VIDEO':
        handlePauseVideo(message.videoId, sendResponse)
        return true

      case 'MOVE_PLAYHEAD':
        handleMovePlayhead(message.videoId, message.seekTime, sendResponse)
        return true

      case 'CAPTURE_SCREENSHOT':
        handleCaptureScreenshot(message.videoId, sendResponse)
        return true

      default:
        sendResponse({ success: false, error: 'Unknown message type' })
    }
  })
}

function handleGetVideoElements(sendResponse: (data: any) => void) {
  const snapshots = Array.from(detectedVideos.entries()).map(([id, video]) => ({
    id,
    src: video.src || video.currentSrc,
    title: document.title,
    duration: video.duration,
    currentTime: video.currentTime,
    paused: video.paused,
    frameIndex: 0,
  }))
  sendResponse(snapshots)
}

function handlePlayVideo(videoId: string, sendResponse: (data: any) => void) {
  const video = detectedVideos.get(videoId)
  if (video) {
    video.play().catch(e => console.error('Play failed:', e))
    sendResponse({ success: true })
  } else {
    sendResponse({ success: false, error: 'Video not found' })
  }
}

function handlePauseVideo(videoId: string, sendResponse: (data: any) => void) {
  const video = detectedVideos.get(videoId)
  if (video) {
    video.pause()
    sendResponse({ success: true })
  } else {
    sendResponse({ success: false, error: 'Video not found' })
  }
}

function handleMovePlayhead(videoId: string, seekTime: number, sendResponse: (data: any) => void) {
  const video = detectedVideos.get(videoId)
  if (video) {
    video.currentTime = seekTime
    sendResponse({ success: true })
  } else {
    sendResponse({ success: false, error: 'Video not found' })
  }
}

function handleCaptureScreenshot(videoId: string, sendResponse: (data: any) => void) {
  const video = detectedVideos.get(videoId)
  if (!video) {
    sendResponse({ success: false, error: 'Video not found' })
    return
  }

  try {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      sendResponse({ success: false, error: 'Cannot get canvas context' })
      return
    }

    ctx.drawImage(video, 0, 0)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9)
    sendResponse({ success: true, data: dataUrl })
  } catch (e) {
    console.error('Screenshot failed:', e)
    sendResponse({ success: false, error: String(e) })
  }
}

// Start initialization
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeContentScript)
} else {
  initializeContentScript()
}
```

---

### Phase 3: Service Worker & Routing (2 steps)

#### Step 10: Scaffold Service Worker

File: `src/entries/background/service-worker.ts`

```typescript
import { useExtensionStore } from '../../state/store'
import type { ContentScriptMessage, PopupMessage } from '../../shared/messages'

console.log('[Service Worker] Starting...')

// Initialize store on service worker startup
useExtensionStore.getState().loadFromStorage()

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  console.log('[Service Worker] Received message:', message.type, 'from', sender.url)

  switch (message.type) {
    case 'GET_VIDEO_ELEMENTS':
      handleGetVideoElements(sender.tabId, sendResponse)
      return true

    case 'UPDATE_SETTINGS':
      handleUpdateSettings(message.settings, sendResponse)
      return true

    case 'REQUEST_STATE':
      handleRequestState(sendResponse)
      return true

    default:
      // Forward control messages to content script
      if (sender.tabId) {
        chrome.tabs.sendMessage(sender.tabId, message, sendResponse)
        return true
      }
  }
})

// Listen for popup connection (long-lived port)
chrome.runtime.onConnect.addListener(port => {
  console.log('[Service Worker] Port connected:', port.name)

  if (port.name === 'popup-port') {
    port.onMessage.addListener(message => {
      console.log('[Service Worker] Popup message:', message.type)

      if (message.type === 'REQUEST_STATE') {
        port.postMessage({
          type: 'STATE_UPDATED',
          state: useExtensionStore.getState(),
        })
      }
    })

    // Send initial state
    port.postMessage({
      type: 'STATE_UPDATED',
      state: useExtensionStore.getState(),
    })
  }
})

function handleGetVideoElements(tabId: number, sendResponse: (data: any) => void) {
  if (!tabId) {
    sendResponse([])
    return
  }

  chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_ELEMENTS' }, response => {
    sendResponse(response || [])
  })
}

function handleUpdateSettings(settings: any, sendResponse: (data: any) => void) {
  useExtensionStore.getState().setSettings(settings)
  chrome.storage.sync.set({ settings })
  sendResponse({ success: true })
}

function handleRequestState(sendResponse: (data: any) => void) {
  sendResponse({
    type: 'STATE_UPDATED',
    state: useExtensionStore.getState(),
  })
}
```

#### Step 11: Create Type-Safe Messaging Helpers

File: `src/shared/utils/extension-api.ts`

```typescript
import type { ContentScriptMessage, PopupMessage, MessageResponse } from '../messages'

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

export function onServiceWorkerMessage(callback: (message: any) => void) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    callback(message)
  })
}
```

---

### Phase 4: React UI (3 steps)

#### Step 12: Create Popup Entry Point

File: `src/entries/popup/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Virtual Remote Control</title>
    <style>
      body {
        margin: 0;
        padding: 0;
        width: 400px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

File: `src/entries/popup/main.tsx`

```typescript
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

const container = document.getElementById('root')
if (container) {
  const root = ReactDOM.createRoot(container)
  root.render(<App />)
}
```

File: `src/entries/popup/App.tsx`

```typescript
import React, { useEffect, useState } from 'react'
import { useExtensionStore } from '../../state/store'
import { connectToServiceWorker } from '../../shared/utils/extension-api'
import type { VideoElement } from '../../shared/messages'

export default function PopupApp() {
  const { isEnabled, setEnabled, videos, setVideos } = useExtensionStore()
  const [localVideos, setLocalVideos] = useState<VideoElement[]>([])
  const [port, setPort] = useState<chrome.runtime.Port | null>(null)

  useEffect(() => {
    // Connect to service worker
    const newPort = connectToServiceWorker('popup-port')
    setPort(newPort)

    newPort.postMessage({ type: 'REQUEST_STATE' })
    newPort.onMessage.addListener(message => {
      if (message.type === 'STATE_UPDATED') {
        setLocalVideos(message.state.videos)
      }
    })

    // Fetch video elements from active tab
    fetchVideoElements()

    return () => newPort.disconnect()
  }, [])

  async function fetchVideoElements() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab.id) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_ELEMENTS' })
        setLocalVideos(response || [])
      } catch (e) {
        console.error('Failed to fetch videos:', e)
      }
    }
  }

  async function controlVideo(action: 'play' | 'pause' | 'skip') {
    if (localVideos.length === 0) return

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab.id) return

    const videoId = localVideos[0].id

    try {
      if (action === 'play') {
        await chrome.tabs.sendMessage(tab.id, { type: 'PLAY_VIDEO', videoId })
      } else if (action === 'pause') {
        await chrome.tabs.sendMessage(tab.id, { type: 'PAUSE_VIDEO', videoId })
      } else if (action === 'skip') {
        const currentTime = localVideos[0].currentTime + 10
        await chrome.tabs.sendMessage(tab.id, {
          type: 'MOVE_PLAYHEAD',
          videoId,
          seekTime: currentTime,
        })
      }

      // Refresh video state
      await new Promise(r => setTimeout(r, 500))
      fetchVideoElements()
    } catch (e) {
      console.error(`Failed to ${action} video:`, e)
    }
  }

  async function captureScreenshot() {
    if (localVideos.length === 0) return

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab.id) return

    const videoId = localVideos[0].id

    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'CAPTURE_SCREENSHOT',
        videoId,
      })

      if (response.success && response.data) {
        // In phase 2, add download/export logic
        console.log('Screenshot captured:', response.data.substring(0, 50) + '...')
      }
    } catch (e) {
      console.error('Failed to capture screenshot:', e)
    }
  }

  return (
    <div style={{ padding: '16px' }}>
      <h2 style={{ margin: '0 0 16px 0' }}>Virtual Remote Control</h2>

      <div style={{ marginBottom: '16px' }}>
        <label>
          <input
            type="checkbox"
            checked={isEnabled}
            onChange={e => setEnabled(e.target.checked)}
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
  )
}
```

#### Step 13: Create Options Page

File: `src/entries/options/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Settings - Virtual Remote Control</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        max-width: 600px;
        margin: 0 auto;
        padding: 20px;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

File: `src/entries/options/main.tsx`

```typescript
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

const container = document.getElementById('root')
if (container) {
  const root = ReactDOM.createRoot(container)
  root.render(<App />)
}
```

File: `src/entries/options/App.tsx`

```typescript
import React, { useEffect, useState } from 'react'
import type { ExtensionSettings } from '../../shared/messages'

export default function OptionsApp() {
  const [settings, setSettings] = useState<ExtensionSettings>({
    isEnabled: true,
    screenshotSaveLocation: 'Downloads',
  })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    // Load settings from chrome.storage.sync
    chrome.storage.sync.get(['settings'], result => {
      if (result.settings) {
        setSettings(result.settings)
      }
    })
  }, [])

  function handleSave() {
    chrome.storage.sync.set({ settings }, () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  return (
    <div>
      <h1>Virtual Remote Control - Settings</h1>

      <div style={{ marginBottom: '16px' }}>
        <label>
          <strong>Screenshot Save Location:</strong>
          <input
            type="text"
            value={settings.screenshotSaveLocation}
            onChange={e =>
              setSettings({
                ...settings,
                screenshotSaveLocation: e.target.value,
              })
            }
            placeholder="e.g., Downloads, Desktop, or full path"
            style={{ marginLeft: '8px', padding: '4px', width: '200px' }}
          />
        </label>
        <p style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
          Folder where screenshots will be saved (relative to Downloads folder, or absolute path)
        </p>
      </div>

      <button onClick={handleSave} style={{ padding: '8px 16px', cursor: 'pointer' }}>
        Save Settings
      </button>

      {saved && <p style={{ color: 'green', marginTop: '8px' }}>Settings saved!</p>}

      <hr style={{ margin: '24px 0' }} />

      <p style={{ fontSize: '12px', color: '#666' }}>
        <strong>Note:</strong> Screenshots are saved as JPG with 90% quality.
      </p>
      <p style={{ fontSize: '12px', color: '#666' }}>
        <strong>Phase 2 Coming:</strong> WebSocket configuration, ad detection settings, and more
        controls!
      </p>
    </div>
  )
}
```

#### Step 14: Create Shared Storage Hook (already in Phase 1, Step 7)

The `useStorage` hook was already created in `src/shared/storage/hooks.ts`. This step confirms it's available for use in React components.

---

### Phase 5: Testing & Code Quality (3 steps)

#### Step 15: Set Up Testing Infrastructure

File: `src/test/setup.ts`

```typescript
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
```

#### Step 16: Create Initial Test Suite

File: `src/shared/utils/__tests__/dom-query.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { findAllVideos } from '../dom-query'

describe('dom-query', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('finds direct video elements', () => {
    container.innerHTML = '<video src="test.mp4"></video>'
    const videos = findAllVideos(container)
    expect(videos).toHaveLength(1)
  })

  it('finds multiple video elements', () => {
    container.innerHTML = `
      <video src="video1.mp4"></video>
      <video src="video2.mp4"></video>
    `
    const videos = findAllVideos(container)
    expect(videos).toHaveLength(2)
  })

  it('returns empty array when no videos found', () => {
    container.innerHTML = '<p>No videos here</p>'
    const videos = findAllVideos(container)
    expect(videos).toHaveLength(0)
  })

  it('finds videos with source child elements', () => {
    container.innerHTML = `
      <video>
        <source src="test.mp4" type="video/mp4" />
      </video>
    `
    const videos = findAllVideos(container)
    expect(videos).toHaveLength(1)
  })
})
```

File: `src/state/__tests__/store.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useExtensionStore } from '../store'
import type { ExtensionSettings } from '../../shared/messages'

describe('useExtensionStore', () => {
  beforeEach(() => {
    // Reset store state
    useExtensionStore.setState({
      isEnabled: true,
      videos: [],
      playbackState: {},
      settings: {
        isEnabled: true,
        captureFormat: 'png',
        captureQuality: 90,
      },
    })
  })

  it('initializes with default state', () => {
    const state = useExtensionStore.getState()
    expect(state.isEnabled).toBe(true)
    expect(state.videos).toEqual([])
  })

  it('updates settings', () => {
    const newSettings: ExtensionSettings = {
      isEnabled: true,
      captureFormat: 'jpg',
      captureQuality: 80,
    }
    useExtensionStore.getState().setSettings(newSettings)
    const state = useExtensionStore.getState()
    expect(state.settings.captureFormat).toBe('jpg')
    expect(state.settings.captureQuality).toBe(80)
  })

  it('toggles enabled state', () => {
    useExtensionStore.getState().setEnabled(false)
    expect(useExtensionStore.getState().isEnabled).toBe(false)

    useExtensionStore.getState().setEnabled(true)
    expect(useExtensionStore.getState().isEnabled).toBe(true)
  })

  it('updates playback state', () => {
    useExtensionStore.getState().updatePlaybackState('video-1', 30.5, true)
    const state = useExtensionStore.getState()
    expect(state.playbackState['video-1']).toEqual({ position: 30.5, isPlaying: true })
  })
})
```

#### Step 17: Configure Linting & Formatting

File: `eslint.config.js`

```typescript
import js from '@eslint/js'
import ts from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: ts.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react-hooks/rules-of-hooks': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
]
```

File: `.prettierrc.json`

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "es5",
  "printWidth": 100,
  "tabWidth": 2
}
```

File: `package.json` (scripts section)

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "lint": "eslint src --ext .ts,.tsx --max-warnings 0",
    "format": "prettier --write src",
    "type-check": "tsc --noEmit",
    "test": "vitest",
    "test:ui": "vitest --ui"
  }
}
```

---

### Phase 6: GitHub Setup & CI/CD (1 step)

#### Step 18: Set Up GitHub Actions

File: `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Type check
        run: npm run type-check

      - name: Lint
        run: npm run lint

      - name: Format check
        run: npx prettier --check src

      - name: Run tests
        run: npm run test -- --run

      - name: Build extension
        run: npm run build

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: extension-dist
          path: dist/
```

File: `.github/workflows/release.yml`

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      bump:
        description: 'Version bump type'
        required: true
        type: choice
        options:
          - patch
          - minor
          - major

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Configure Git
        run: |
          git config --global user.name 'GitHub Actions'
          git config --global user.email 'actions@github.com'

      - name: Install dependencies
        run: npm ci

      - name: Bump version
        id: bump
        run: |
          npm version ${{ github.event.inputs.bump }} --no-git-tag-version
          echo "NEW_VERSION=$(jq -r .version package.json)" >> $GITHUB_OUTPUT

      - name: Build extension
        run: npm run build

      - name: Create Release
        uses: actions/create-release@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tag_name: v${{ steps.bump.outputs.NEW_VERSION }}
          release_name: Release v${{ steps.bump.outputs.NEW_VERSION }}
          draft: false
          prerelease: false

      - name: Commit and push
        run: |
          git add package.json package-lock.json
          git commit -m "chore: bump version to ${{ steps.bump.outputs.NEW_VERSION }}"
          git push
          git push --tags
```

---

## Summary

This plan provides a complete roadmap for initializing and building the "Virtual Remote Control" Chrome extension with:

- ✅ Scalable, modular architecture (popup, options, content script, service worker)
- ✅ Type-safe messaging between extension parts
- ✅ State management with persistence (Zustand + chrome.storage.sync)
- ✅ Full React UI with hooks
- ✅ Video detection across iframes
- ✅ Play/pause/skip/screenshot controls
- ✅ Comprehensive testing setup (Vitest)
- ✅ Code quality (ESLint, Prettier)
- ✅ CI/CD automation (GitHub Actions)
- ✅ Early Git checkpoint at Step 5 with README, LICENSE (GNU v3), and .gitignore

### Key Change: Early Git Checkpoint

**Step 5** now creates baseline documentation and `.gitignore` **after** setting up Vite and **before** adding extension-specific code. This allows you to:

1. Manually commit after Step 5 as a clean baseline
2. Track changes to extension-specific code seperately
3. Have clear separation between generic setup and extension logic

You will manually run git commands (`git init`, `git add .`, `git commit`). I will not execute git commands—you retain full control of commits and pushes.

### Next Steps

1. Proceed with Phase 1 steps (1-7)
2. After Step 5, manually run: `git init`, `git add .`, and `git commit -m "Initial commit: baseline project structure"`
3. Continue with Steps 6-7 to add extension-specific types and state management
4. Test locally with `npm run dev`
5. Proceed to Phase 2 once Phase 1 is verified
