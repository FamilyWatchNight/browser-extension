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

export interface VideoPlaybackUpdate {
  currentTime: number
  paused: boolean
  duration: number
}

export interface ActionResponse {
  success: boolean
  error?: string
}

export interface ScreenshotResponse extends ActionResponse {
  data?: string
  contentBounds?: ScreenshotBounds
}

export interface ScreenshotBounds {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
}

export interface ExtensionSettings {
  isEnabled: boolean
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

