// Message types sent from content script to background
export type ContentScriptMessage =
  | { type: 'GET_VIDEO_ELEMENTS' }
  | { type: 'GET_CAPTION_DIAGNOSTICS' }
  | { type: 'DISCOVER_CAPTION_SOURCES' }
  | { type: 'CAPTION_DISCOVERY_UPDATE'; discovery: CaptionDiscoveryResponse }
  | { type: 'RETRIEVE_CAPTION_SOURCE_IN_PAGE'; candidate: CaptionSourceCandidate }
  | { type: 'PLAY_VIDEO'; videoId: string }
  | { type: 'PAUSE_VIDEO'; videoId: string }
  | { type: 'MOVE_PLAYHEAD'; videoId: string; seekTime: number }
  | { type: 'CAPTURE_SCREENSHOT'; videoId: string }
  | { type: 'START_AUDIO_CAPTURE'; videoId: string }
  | { type: 'STOP_AUDIO_CAPTURE' }
  | { type: 'VIDEO_STATE_UPDATE'; videos: VideoElement[] }
  | { type: 'SET_PLAYBACK_TRACE_CONTENT'; active: boolean };

// Message types sent from popup/options to background
export type PopupMessage =
  | { type: 'UPDATE_SETTINGS'; settings: ExtensionSettings }
  | { type: 'REQUEST_STATE' }
  | { type: 'REQUEST_CAPTION_STATE'; tabId: number }
  | { type: 'GET_PLAYBACK_TRACE_STATE'; tabId: number }
  | { type: 'START_PLAYBACK_TRACE'; tabId: number }
  | { type: 'STOP_PLAYBACK_TRACE'; tabId: number }
  | { type: 'DELETE_PLAYBACK_TRACE' }
  | { type: 'EXPORT_PLAYBACK_TRACE' }
  | { type: 'DISCOVER_CAPTION_SOURCES'; tabId: number }
  | {
      type: 'SET_CAPTION_CDP_MONITORING';
      tabId: number;
      action: 'start' | 'pause' | 'resume';
    }
  | { type: 'RETRIEVE_CAPTION_SOURCE'; tabId: number; candidateId: string }
  | { type: 'START_TAB_AUDIO_CAPTURE'; tabId: number }
  | { type: 'STOP_TAB_AUDIO_CAPTURE' }
  | { type: 'PLAYBACK_TRACE_CONTENT_READY' }
  | { type: 'PLAYBACK_TRACE_CONTENT_EVENT'; event: PlaybackTraceContentEvent };

// Message types sent from background to popup/content script
export type BackgroundMessage =
  | { type: 'STATE_UPDATED'; state: ExtensionState; tabId?: number }
  | { type: 'CAPTION_STATE_UPDATED'; state: CaptionCaptureState }
  | { type: 'PLAYBACK_TRACE_UPDATED'; state: PlaybackTraceState }
  | { type: 'SETTINGS_CHANGED'; settings: ExtensionSettings };

export type PlaybackTracePhase = 'recording' | 'completed' | 'limit-ended' | 'failed';

export type PlaybackTraceEndReason =
  'manual' | 'duration-limit' | 'event-limit' | 'size-limit' | 'debugger-detached' | 'error';

export interface PlaybackTraceEvent {
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  category: 'trace' | 'network' | 'playback' | 'interaction' | 'user';
  name: string;
  url?: string;
  method?: string;
  resourceType?: string;
  status?: number;
  mimeType?: string;
  encodedDataLength?: number;
  manifestFormat?: 'dash-mpd' | 'hls';
  manifestText?: string;
  mediaTime?: number;
  previousMediaTime?: number;
  mediaTimes?: Array<{ videoId: string; currentTime: number }>;
  interaction?: {
    type: 'click';
    isTrusted: boolean;
    targetTag: string;
    targetRole?: string;
    clientX: number;
    clientY: number;
    button: number;
  };
  duration?: number;
  paused?: boolean;
  repeatCount?: number;
  lastRepeatedAt?: string;
  detail?: string;
}

export interface PlaybackTraceState {
  traceId: string;
  tabId: number;
  phase: PlaybackTracePhase;
  startedAt: string;
  endedAt?: string;
  elapsedMs: number;
  eventCount: number;
  serializedBytes: number;
  bodyBytes: number;
  warning?: string;
  endReason?: PlaybackTraceEndReason;
  error?: string;
}

export interface PlaybackTraceContentEvent {
  name: string;
  timestamp: string;
  videoId?: string;
  mediaTime?: number;
  previousMediaTime?: number;
  mediaTimes?: Array<{ videoId: string; currentTime: number }>;
  interaction?: PlaybackTraceEvent['interaction'];
  duration?: number;
  paused?: boolean;
  detail?: string;
}

export interface PlaybackTraceResponse {
  success: boolean;
  state?: PlaybackTraceState;
  events?: PlaybackTraceEvent[];
  error?: string;
}

// Types for video elements detected
export interface VideoElement {
  id: string; // Unique identifier
  src: string; // Video source URL
  title: string; // Page title or video title
  duration: number; // Duration in seconds
  currentTime: number; // Current playback position
  paused: boolean; // Is playback paused
  frameIndex: number; // Which frame (0 = main, 1+ = iframe)
  width: number; // Rendered width in CSS pixels
  height: number; // Rendered height in CSS pixels
  isVisible: boolean; // Whether the element is rendered and visible
  hasSource: boolean; // Whether the element has a media source
  readyState: number; // HTMLMediaElement ready state
}

export interface VideoPlaybackUpdate {
  currentTime: number;
  paused: boolean;
  duration: number;
}

export interface ActionResponse {
  success: boolean;
  error?: string;
}

export interface ScreenshotResponse extends ActionResponse {
  data?: string;
  contentBounds?: ScreenshotBounds;
}

export interface AudioCaptureResponse extends ActionResponse {
  data?: string;
  mimeType?: string;
}

export type CaptionDiagnosticClassification =
  'native-track' | 'dom-overlay' | 'player-control' | 'unknown' | 'inaccessible';

export interface CaptionDiagnosticTrack {
  kind: string;
  label: string;
  language: string;
  mode: TextTrackMode;
  readyState: number;
  source: string;
  cueCount?: number;
}

export interface CaptionDiagnosticEvidence {
  type: 'native-track' | 'dom-overlay' | 'player-control' | 'limitation';
  description: string;
  selector?: string;
}

export interface VideoCaptionDiagnostics {
  videoId: string;
  title: string;
  classification: CaptionDiagnosticClassification;
  tracks: CaptionDiagnosticTrack[];
  evidence: CaptionDiagnosticEvidence[];
  limitations: string[];
}

export interface CaptionDiagnosticsResponse {
  capturedAt: string;
  videos: VideoCaptionDiagnostics[];
  pageEvidence: CaptionDiagnosticEvidence[];
  limitations: string[];
}

export type CaptionSourceKind =
  'native-track' | 'resource-url' | 'provider-data' | 'manifest' | 'dom-sample' | 'manual';

export type CaptionSourceFormat = 'webvtt' | 'ttml' | 'srt' | 'json' | 'unknown';

export type CaptionConfidence = 'high' | 'medium' | 'low';

export type CaptionTimingKind = 'exact' | 'sampled' | 'inferred' | 'unknown';

export type CaptionFailureCategory =
  | 'unsupported-format'
  | 'network'
  | 'cors'
  | 'auth'
  | 'size-limit'
  | 'timeout'
  | 'invalid-payload'
  | 'inaccessible';

export type CaptionRetrievalFailureStage =
  | 'url-validation'
  | 'request'
  | 'response'
  | 'response-body'
  | 'payload-validation'
  | 'content-script-bridge';

export interface CaptionRetrievalFailureDiagnostics {
  stage: CaptionRetrievalFailureStage;
  endpoint?: string;
  httpStatus?: number;
  contentType?: string;
  responseBytes?: number;
}

export interface CaptionSourceEvidence {
  description: string;
  selector?: string;
  fieldPath?: string;
}

export interface CaptionSourceCandidate {
  id: string;
  videoId: string;
  nativeTrackIndex?: number;
  kind: CaptionSourceKind;
  format: CaptionSourceFormat;
  url?: string;
  displayUrl?: string;
  language?: string;
  label?: string;
  confidence: CaptionConfidence;
  timing: CaptionTimingKind;
  evidence: CaptionSourceEvidence[];
  limitations?: string[];
}

export interface CaptionDiscoveryResponse {
  schemaVersion: 1;
  capturedAt: string;
  pageUrl?: string;
  provider?: string;
  candidates: CaptionSourceCandidate[];
  limitations: string[];
}

export type CaptionCapturePhase =
  | 'idle'
  | 'discovering'
  | 'non-cdp-complete'
  | 'cdp-monitoring'
  | 'cdp-paused'
  | 'complete'
  | 'no-match'
  | 'failed';

export interface CaptionCaptureState {
  tabId: number;
  phase: CaptionCapturePhase;
  discovery?: CaptionDiscoveryResponse;
  retrievals: Record<string, CaptionRetrievalResponse>;
  retrievingCandidateIds: string[];
  diagnostics: CaptionCaptureDiagnostics;
  error?: string;
  updatedAt: string;
}

export interface CaptionCaptureDiagnostics {
  responsesObserved: number;
  bodiesRead: number;
  bodyReadFailures: number;
  candidatesAccepted: number;
  ignoredByReason: Record<string, number>;
}

export interface CaptionRetrievalRequest {
  tabId: number;
  candidateId: string;
}

export interface CaptionWarning {
  code: string;
  message: string;
  cueId?: string;
  field?: string;
}

export interface CaptionSpan {
  text: string;
  speaker?: string;
  voice?: string;
  italic?: boolean;
  bold?: boolean;
  underline?: boolean;
  className?: string;
}

export interface CaptionCueSettings {
  line?: string;
  position?: string;
  size?: string;
  align?: string;
  vertical?: string;
  region?: string;
}

export interface CaptionCue {
  id: string;
  start: number;
  end: number;
  text: string;
  spans?: CaptionSpan[];
  settings?: CaptionCueSettings;
  speaker?: string;
  voice?: string;
  language?: string;
  confidence: CaptionConfidence;
  originalTiming?: { start: string; end: string };
}

export interface CaptionStyle {
  id: string;
  foreground?: string;
  background?: string;
  fontFamily?: string;
  fontSize?: string;
  fontStyle?: string;
  fontWeight?: string;
  textAlign?: string;
  position?: string;
}

export interface CaptionProvenance {
  sourceKind: CaptionSourceKind;
  sourceFormat: CaptionSourceFormat;
  pageUrl?: string;
  sourceUrl?: string;
  provider?: string;
  language?: string;
  label?: string;
  retrievedAt: string;
  contentType?: string;
  authentication: 'not-needed' | 'session' | 'unknown' | 'failed';
}

export interface CaptionUncertainty {
  confidence: CaptionConfidence;
  timing: CaptionTimingKind;
  inferredFields: string[];
  omittedFeatures: string[];
  limitations: string[];
}

export interface NormalizedCaptionDocument {
  schemaVersion: 1;
  documentId: string;
  language?: string;
  languageConfidence?: CaptionConfidence;
  title?: string;
  duration?: number;
  capturedAt: string;
  cues: CaptionCue[];
  styles?: CaptionStyle[];
  source: CaptionProvenance;
  uncertainty: CaptionUncertainty;
  warnings: CaptionWarning[];
}

export interface RawCaptionArtifact {
  candidateId: string;
  format: CaptionSourceFormat;
  filename: string;
  contentType?: string;
  payload: string;
  byteLength: number;
}

export interface CaptionRetrievalResponse {
  success: boolean;
  candidateId: string;
  raw?: RawCaptionArtifact;
  normalized?: NormalizedCaptionDocument;
  warnings: CaptionWarning[];
  failure?: {
    category: CaptionFailureCategory;
    message: string;
    diagnostics?: CaptionRetrievalFailureDiagnostics;
  };
}

export interface ScreenshotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface ExtensionSettings {
  isEnabled: boolean;
}

export interface ExtensionState {
  isEnabled: boolean;
  videos: VideoElement[];
  playbackState: Record<string, { position: number; isPlaying: boolean }>;
  settings: ExtensionSettings;
}

// Type helpers for responses
export type MessageResponse<T extends ContentScriptMessage | PopupMessage> = T extends {
  type: 'GET_VIDEO_ELEMENTS';
}
  ? VideoElement[]
  : T extends { type: 'GET_CAPTION_DIAGNOSTICS' }
    ? CaptionDiagnosticsResponse
    : T extends { type: 'DISCOVER_CAPTION_SOURCES' }
      ? CaptionDiscoveryResponse
      : T extends { type: 'RETRIEVE_CAPTION_SOURCE' }
        ? CaptionRetrievalResponse
        : T extends { type: 'REQUEST_STATE' }
          ? ExtensionState
          : T extends { type: 'UPDATE_SETTINGS' }
            ? { success: boolean }
            : T extends { type: 'PLAY_VIDEO' | 'PAUSE_VIDEO' | 'MOVE_PLAYHEAD' }
              ? { success: boolean }
              : T extends { type: 'CAPTURE_SCREENSHOT' }
                ? { success: boolean; data?: string }
                : T extends { type: 'START_AUDIO_CAPTURE' | 'STOP_AUDIO_CAPTURE' }
                  ? AudioCaptureResponse
                  : T extends { type: 'START_TAB_AUDIO_CAPTURE' | 'STOP_TAB_AUDIO_CAPTURE' }
                    ? AudioCaptureResponse
                    : never;
