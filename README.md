# Family Watch Night - Chrome Extension

## Virtual Remote Control for Video Streaming Services

A Chrome extension that detects and controls video playback on any streaming service. The extension finds video elements even when buried in iframes, provides playback controls (play/pause/skip), captures screenshots, and tracks playback events.

### Features

- **Automatic Video Detection**: Recursively finds video elements across iframes
- **Playback Controls**: Play, pause, and seek through video content
- **Screenshot Capture**: Take screenshots of video frames (JPG format, 90% quality)
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

```powershell
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
```

### Loading in Chrome

1. Run `npm run build` to create the `dist/` folder
2. Go to `chrome://extensions/` in Chrome
3. Enable "Developer mode" (top right toggle)
4. Click "Load unpacked"
5. Select the `dist/` folder

### Project Structure

```
src/
├── entries/
│   ├── popup/          # Extension popup UI
│   ├── options/        # Settings page
│   ├── content-script/ # Injected into web pages
│   └── background/     # Service worker
├── shared/             # Shared utilities and types
├── state/              # Zustand store
└── test/               # Test utilities and mocks
```

### Development Phases

- **Phase 1**: Project setup, basic architecture ✓
- **Phase 2**: Content script & DOM detection
- **Phase 3**: Service worker & message routing
- **Phase 4**: React UI (popup + options)
- **Phase 5**: Testing & code quality
- **Phase 6**: GitHub setup & CI/CD

### License

GNU General Public License v3.0 (GPL-3.0)

See [LICENSE](./LICENSE) for details.
