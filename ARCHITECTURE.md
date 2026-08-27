# Family Watch Night Extension Architecture

This document describes how the browser extension is assembled and how its parts communicate. The most important idea is that an extension is not one page: Chrome runs several separate JavaScript contexts, each with its own lifetime and access to browser APIs.

## The Main Pieces

```text
+-----------------------+       runtime messages       +----------------------+
| Content script        | ---------------------------> | Service worker       |
| Runs inside web page  |                              | Background broker    |
+-----------+-----------+                              +----------+-----------+
            ^                                                     |
            | tabs.sendMessage                                    | popup port
            |                                                     v
+-----------+-----------+                              +----------+-----------+
| The web page          |                              | Popup                |
| Videos and DOM        |                              | Short-lived UI       |
+-----------------------+                              +----------------------+

+-----------------------+
| Options page          |
| Settings UI           | ---- chrome.storage.sync ----+
+-----------------------+                              |
                                                       v
                                             Shared extension settings
```

The arrows represent communication paths, not imports. The contexts do not share ordinary JavaScript memory. They communicate through Chrome APIs and persistent storage.

### `src/manifest.json`

The Manifest V3 declaration tells Chrome what to load and what permissions the extension needs:

- Registers `src/entries/background/service-worker.ts` as the background service worker.
- Registers `src/entries/content-script/index.ts` for matching web pages at `document_end`.
- Defines the popup at `src/entries/popup/index.html`.
- Defines the options page at `src/entries/options/index.html`.
- Requests `storage`, `scripting`, and `tabs` permissions, plus access to all URLs.
- Declares the extension icons.

The manifest is the runtime wiring. `vite.config.ts` and the package scripts build these source entry points into an installable extension.

### `src/entries/background/service-worker.ts`

The service worker is the background coordinator. It:

- Creates the Zustand store by importing `src/state/store.ts` and starts loading persisted settings.
- Receives runtime messages with `chrome.runtime.onMessage`.
- Receives long-lived connections with `chrome.runtime.onConnect`.
- Keeps a set of connected popup ports.
- Stores video snapshots received from content scripts.
- Broadcasts updated state to connected popup ports.
- Forwards some messages to a tab when a message has a `sender.tab.id`.

A service worker is event-driven and may be stopped by Chrome when idle, then started again for a later event. Its in-memory state should therefore be treated as temporary. Settings are restored from `chrome.storage.sync` during startup; the current video list is discovered again by the content script.

### `src/entries/content-script/index.ts`

The content script runs in the context of a matching web page. It is the part that can inspect the page DOM and interact with its `HTMLVideoElement` objects. It:

- Finds videos in the page and accessible same-origin iframes.
- Watches DOM changes and iframe loads so newly added videos can be detected.
- Keeps an internal map from a generated video ID to each `HTMLVideoElement`.
- Listens for playback and metadata events.
- Handles commands such as play, pause, seek, and screenshot capture.
- Sends video state updates to the service worker.

The manifest sets `all_frames` to `false`, so Chrome injects the content script into the top-level page. The code can still inspect same-origin iframe documents recursively. Cross-origin iframe documents are skipped because the browser blocks that DOM access.

### `src/entries/popup/`

- `index.html` is the popup document shell.
- `main.tsx` mounts the React application.
- `App.tsx` provides the remote-control UI.

The popup is a temporary page opened by clicking the extension action. It connects to the service worker with a named long-lived port, asks for current shared state, and listens for state broadcasts. It also queries the active tab and sends video discovery and playback commands directly to that tab's content script.

The popup can disappear as soon as the user clicks elsewhere. Its cleanup disconnects the port.

### `src/entries/options/`

- `index.html` is the options document shell.
- `main.tsx` mounts the React application.
- `App.tsx` loads and saves the screenshot location in `chrome.storage.sync`.

The options page is separate from the popup and has a longer-lived page-like lifecycle. Its settings are persisted so they survive extension restarts and are available to other extension contexts.

### Shared contracts and utilities

- `src/shared/messages.ts` defines the TypeScript message unions and data structures. `VideoElement` is a snapshot of a video, not the DOM element itself. `ExtensionState` is the state shared with the popup.
- `src/shared/storage/schema.ts` defines the storage shape and validates settings read from Chrome storage.
- `src/shared/storage/hooks.ts` contains a generic React storage hook. The current popup and options implementations use their own direct APIs instead.
- `src/shared/utils/dom-query.ts` finds videos through the document, same-origin iframes, and shadow roots.
- `src/shared/utils/video-element.ts` creates video snapshots and installs/removes media event listeners.
- `src/shared/utils/extension-api.ts` contains wrappers for one-shot messages and service-worker connections. The current popup uses the connection helper; some direct Chrome APIs remain in `App.tsx`.
- `src/state/store.ts` defines the Zustand store, defaults, storage loading, and storage-change synchronization.
- `src/shared/ui/components/` is reserved for reusable UI components; it is currently empty.
- `src/styles/globals.css` is reserved for global styling; it currently contains no implementation.

### Tests and fixtures

- `src/test/setup.ts` installs the global jsdom/Chrome test setup.
- `src/test/fixtures/chrome.ts` supplies fake Chrome APIs, message listeners, tabs, and a fake `chrome.runtime.Port`.
- `src/test/__tests__/` tests the content script, service worker, popup, store, DOM search, and video event behavior.

The fixture does not create a real browser process. It records listeners and calls them directly so tests can verify message contracts and lifecycle behavior in isolation.

## Lifecycle

### Extension startup

1. Chrome reads the manifest and registers the service worker, content script, popup, and options page.
2. The build tool resolves the TypeScript and React entry points.
3. The service worker starts when Chrome needs it, imports the store, and begins loading settings.
4. A matching web page receives the content script at `document_end`.
5. The content script registers its message listener before initialization, then scans for videos and installs DOM/iframe observers.

### Content-script lifecycle

When the page structure changes, a mutation observer or iframe `load` handler schedules a debounced rescan. When a video is discovered, the content script assigns an ID, stores the DOM element, and installs media listeners. When a video is removed, its listeners and map entry are cleaned up.

Media events such as `play`, `pause`, `timeupdate`, and `loadedmetadata` schedule a debounced snapshot update. Debouncing prevents a burst of browser events from producing a message for every individual event.

### Popup lifecycle

1. The user opens the popup.
2. React mounts `PopupApp`.
3. The popup calls `chrome.runtime.connect({ name: 'popup-port' })`.
4. The service worker stores that port and immediately sends `STATE_UPDATED`.
5. The popup also sends `REQUEST_STATE` over the port, which causes another state response.
6. The popup queries the active tab and retries `GET_VIDEO_ELEMENTS` up to four times. This allows time for a page's content script to initialize.
7. When the popup closes, React disconnects the port. The service worker removes it from its set.

### Service-worker lifecycle

The service worker is not a permanently running background page. Chrome can suspend it between events. A later message or connection starts it again. The port connection exists only while the popup is open, so the worker should not rely on a popup being connected.

## Communication Vocabulary

### One-shot runtime message

`chrome.runtime.sendMessage(message)` sends one message through the extension runtime. The recipient uses `chrome.runtime.onMessage.addListener(...)`. The content script uses this path for `VIDEO_STATE_UPDATE` messages sent to the service worker.

The listener receives three important values:

- `message`: the application payload, such as `{ type: 'VIDEO_STATE_UPDATE', videos }`.
- `sender`: Chrome metadata about who sent it.
- `sendResponse`: a callback for the response.

Returning `true` from an `onMessage` listener tells Chrome that the response may be sent asynchronously.

### Tab message

`chrome.tabs.sendMessage(tabId, message)` sends a one-shot message to the content script in a particular tab. The popup uses this for:

- `GET_VIDEO_ELEMENTS`
- `PLAY_VIDEO`
- `PAUSE_VIDEO`
- `MOVE_PLAYHEAD`
- `CAPTURE_SCREENSHOT`

These commands go directly from the popup to the content script. They do not travel through the popup port or through the service worker in the current implementation.

### What is a sender tab?

A `sender tab` is the browser tab associated with the context that sent a runtime message. In a service-worker listener, it appears as `sender.tab`, and its `id` is the tab ID that can be passed to `chrome.tabs.sendMessage`.

For example, when a content script calls `chrome.runtime.sendMessage(...)`, the service worker can inspect `sender.tab?.id` to know which page the message came from. This matters because the worker may be handling messages from several tabs.

A sender may not have a tab. Messages originating from extension pages, such as the popup, commonly have different sender metadata. That is why the service worker checks `sender.tab?.id` before forwarding a message.

### Port

A `chrome.runtime.Port` is a named, long-lived connection rather than a single request/response. One side creates it with:

```ts
const port = chrome.runtime.connect({ name: 'popup-port' });
```

The other side receives it in `chrome.runtime.onConnect`. Both sides can use `port.postMessage(...)`, and both sides can listen with `port.onMessage.addListener(...)`.

A port also has an `onDisconnect` event. In this extension, closing the popup disconnects its port, and the service worker removes that port from `popupPorts` so it will no longer receive broadcasts.

### Popup port

The `popup-port` is simply the particular port name chosen for the popup-to-service-worker connection. It is used for shared state synchronization:

```text
Popup -- REQUEST_STATE --> Service worker
Popup <-- STATE_UPDATED -- Service worker
Service worker -- STATE_UPDATED --> every connected popup
```

The name is an application convention. It is not a special Chrome port type.

### Port request

A port request is a normal application message sent over a port. In this codebase it is:

```ts
port.postMessage({ type: 'REQUEST_STATE' });
```

It is not the same as `chrome.runtime.sendMessage`. The service worker handles it in the port's `port.onMessage` listener and replies with the current Zustand state.

## Information Flow: Things Happening in the Content Window

Here, "content window" means the web page where the content script is running.

### Page structure changes

```text
Page adds/removes a video or iframe
  -> MutationObserver or iframe load handler fires
  -> content script schedules a debounced rescan
  -> videos are added/removed from the internal map
  -> event listeners are installed or cleaned up
```

A structure change alone does not send `VIDEO_STATE_UPDATE`. It changes what the next discovery request will return.

### Playback or metadata changes

```text
video play/pause/timeupdate/loadedmetadata event
  -> content script schedules a debounced snapshot
  -> chrome.runtime.sendMessage(VIDEO_STATE_UPDATE)
  -> service worker calls store.setVideos(videos)
  -> service worker broadcasts STATE_UPDATED to popup ports
  -> popup replaces its local video snapshots
```

The message contains serializable snapshots. It does not contain the `HTMLVideoElement`, because DOM objects cannot be passed between extension contexts.

The service worker also acknowledges the update with `{ success: true }`, although the content script does not need to use that response.

## Information Flow: Interactive Actions in the Popup

### Discover videos

```text
Popup opens
  -> chrome.tabs.query({ active: true, currentWindow: true })
  -> get the active tab ID
  -> chrome.tabs.sendMessage(tabId, GET_VIDEO_ELEMENTS)
  -> content script rescans and returns VideoElement[]
  -> popup stores the snapshots in localVideos
```

The popup retries the request because the content script may not yet be ready after navigation. A failure or an empty result on an early attempt does not immediately mean the page has no videos.

### Play, pause, or skip

```text
User clicks a control
  -> popup selects the active tab and a video ID
  -> popup sends PLAY_VIDEO, PAUSE_VIDEO, or MOVE_PLAYHEAD to the tab
  -> content script looks up the real HTMLVideoElement by ID
  -> content script performs the DOM/media operation
  -> popup waits briefly, then asks for fresh video snapshots
  -> later media events also update the service worker and popup ports
```

The video ID is only an identifier. The actual DOM element remains inside the content script's page context.

### Capture a screenshot

```text
Popup sends CAPTURE_SCREENSHOT to the active tab
  -> content script looks up the video
  -> content script draws it to a canvas
  -> content script returns a JPEG data URL
  -> popup downloads the JPEG to the Downloads folder
```

Screenshots are downloaded to the browser's Downloads folder.

## Information Flow: Settings and State

There are two different kinds of state:

- Persisted settings: `settings` and `isEnabled` in `chrome.storage.sync`.
- Runtime state: detected `videos` and `playbackState` in the service worker's Zustand store.

The store starts with defaults, then loads persisted values. Calling `setSettings` or `setEnabled` updates the in-memory store and writes to sync storage. The `chrome.storage.onChanged` listener keeps contexts that use the store aligned when another context changes those values.

Video snapshots are not persisted. They are page-specific and can become invalid when a tab navigates, so they are rediscovered from the content script.

## How the Service-worker Tests Map to the Architecture

The service-worker tests use the fake Chrome fixture to invoke the same callbacks Chrome would invoke:

- **"forwards video queries to the sender tab"**: supplies a message with `sender.tab.id = 42` and verifies that the worker sends `GET_VIDEO_ELEMENTS` to tab 42.
- **"stores video updates and broadcasts them to popup ports"**: connects the fake `popup-port`, supplies a `VIDEO_STATE_UPDATE`, and verifies that the worker updates state and calls `port.postMessage` with `STATE_UPDATED`.
- **"sends current state on port requests and stops after disconnect"**: sends `REQUEST_STATE` through `port.onMessage`, then triggers `port.onDisconnect` and verifies that later broadcasts no longer use that port.

So, when a test says "sender tab," look for the `sender` argument of the runtime message listener. When it says "popup port," look for the fake long-lived `Port` created by `chrome.runtime.connect`. When it says "port request," look for a message delivered to `port.onMessage`, rather than a call to `chrome.runtime.onMessage`.

## A Useful Boundary to Remember

- The **content script owns the page and real video elements**.
- The **popup owns the temporary user interface**.
- The **service worker owns cross-context coordination and shared runtime state**.
- **Sync storage owns settings that must survive restarts**.
- **Messages carry snapshots and commands; they do not move DOM elements or ordinary in-memory objects between contexts**.
