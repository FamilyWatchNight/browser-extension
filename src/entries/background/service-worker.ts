import type {
  ActionResponse,
  AudioCaptureResponse,
  BackgroundMessage,
  CaptionCaptureDiagnostics,
  CaptionCapturePhase,
  CaptionCaptureState,
  CaptionDiscoveryResponse,
  CaptionRetrievalResponse,
  CaptionSourceCandidate,
  ContentScriptMessage,
  ExtensionSettings,
  ExtensionState,
  PlaybackTraceEndReason,
  PlaybackTraceEvent,
  PlaybackTraceResponse,
  PlaybackTraceState,
  PopupMessage,
  VideoElement,
} from '../../shared/messages';
import { isExtensionSettings } from '../../shared/storage/schema';
import { detectCaptionFormat } from '../../shared/utils/caption-fetch';
import { normalizeCaptionPayload } from '../../shared/utils/caption-normalize';
import {
  isWorthReadingCaptionResponse,
  validateCaptionPayload,
} from '../../shared/utils/caption-validation';
import {
  PLAYBACK_TRACE_CHUNK_SIZE,
  PLAYBACK_TRACE_MAX_BODY_BYTES,
  PLAYBACK_TRACE_MAX_BYTES,
  PLAYBACK_TRACE_MAX_DURATION_MS,
  PLAYBACK_TRACE_MAX_EVENTS,
  PLAYBACK_TRACE_MAX_MANIFEST_BYTES,
  PLAYBACK_TRACE_MAX_YOUTUBE_RESPONSE_BYTES,
  PLAYBACK_TRACE_PERSIST_BATCH_SIZE,
  PLAYBACK_TRACE_WARNING_RATIO,
  getPlaybackTraceEventSize,
  getPlaybackTraceLimitReason,
  redactPlaybackTraceUrl,
  sanitizePlaybackManifest,
  summarizeYouTubeAdResponse,
} from '../../shared/utils/playback-trace';
import { useExtensionStore } from '../../state/store';

console.log('[Service Worker] Starting...');

// Initialize store on service worker startup
useExtensionStore.getState().loadFromStorage();

const popupPorts = new Set<chrome.runtime.Port>();
let pendingTabCaptureStart: ((response: AudioCaptureResponse) => void) | undefined;
let pendingTabCaptureStop: ((response: AudioCaptureResponse) => void) | undefined;
const captionCandidatesByTab = new Map<number, CaptionDiscoveryResponse>();
const cdpCandidatesByTab = new Map<number, CaptionSourceCandidate[]>();
const captionRetrievalsByTab = new Map<number, Map<string, CaptionRetrievalResponse>>();
const captionPayloadsByTab = new Map<number, Map<string, CapturedCaptionPayload>>();
const debuggerCapturesByTab = new Set<number>();
const debuggerCapturePausersByTab = new Map<number, () => void>();
const cdpCaptureTasksByTab = new Map<number, Promise<void>>();
const captionStatesByTab = new Map<number, CaptionCaptureState>();
const retrievingCandidateIdsByTab = new Map<number, Set<string>>();
const captionDiscoveryTasksByTab = new Map<number, Promise<CaptionDiscoveryResponse>>();
const CAPTION_STATE_STORAGE_KEY = 'captionCaptureStates';
const PLAYBACK_TRACE_META_KEY = 'playbackTraceMeta';
const PLAYBACK_TRACE_ALARM_PREFIX = 'playbackTrace:';

type PersistedCaptionCaptureState = CaptionCaptureState & {
  cdpCandidates: CaptionSourceCandidate[];
  payloads: Record<string, CapturedCaptionPayload>;
};

let captionPersistenceQueue = Promise.resolve();
const captionStateReady = restoreCaptionStates().catch((error) => {
  console.error('[Service Worker] Failed to restore caption state:', formatError(error));
});

type PlaybackTraceRecord = {
  state: PlaybackTraceState;
  events: PlaybackTraceEvent[];
  stopping: boolean;
  debuggerAttached: boolean;
  debuggerEventListener?: (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ) => void;
  persistenceQueue: Promise<void>;
  lastPersistedEventCount: number;
  pendingUpdates: number;
  pendingResponseCaptures: Set<Promise<void>>;
};

let playbackTrace: PlaybackTraceRecord | undefined;
type PlaybackTraceRequest = {
  url: string;
  method?: string;
  resourceType?: string;
  status?: number;
  mimeType?: string;
  contentLength?: number;
  encodedDataLength?: number;
};
const playbackTraceRequestsByTab = new Map<number, Map<string, PlaybackTraceRequest>>();
const playbackTraceReady = restorePlaybackTrace().catch((error) => {
  console.error('[Service Worker] Failed to restore playback trace:', formatError(error));
});

type CapturedCaptionPayload = {
  payload: string;
  contentType?: string;
  byteLength: number;
  finalUrl: string;
};

type CdpCaptureResult = {
  payloads: CapturedCaptionPayload[];
  responseCount: number;
  bodyReadCount: number;
  bodyReadFailures: number;
  ignoredByReason: Record<string, number>;
  paused?: boolean;
};

type OffscreenMessage =
  | { target: 'background'; type: 'TAB_AUDIO_CAPTURE_STARTED'; mimeType: string }
  | { target: 'background'; type: 'TAB_AUDIO_CAPTURE_ERROR'; error: string }
  | { target: 'background'; type: 'TAB_AUDIO_CAPTURE_COMPLETE'; data: string; mimeType: string };

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener(
  (message: ContentScriptMessage | PopupMessage | OffscreenMessage, sender, sendResponse) => {
    if ('target' in message && message.target === 'background') {
      handleOffscreenMessage(message);
      return false;
    }

    switch (message.type) {
      case 'GET_VIDEO_ELEMENTS':
        if (sender.tab?.id) {
          handleGetVideoElements(sender.tab?.id, sendResponse);
        }
        return true;
      case 'DISCOVER_CAPTION_SOURCES':
        if ('tabId' in message) {
          handleDiscoverCaptionSources(message.tabId, sendResponse);
        } else if (sender.tab?.id) {
          handleDiscoverCaptionSources(sender.tab.id, sendResponse);
        }
        return true;
      case 'CAPTION_DISCOVERY_UPDATE':
        if (sender.tab?.id !== undefined) {
          void handleCaptionDiscoveryUpdate(sender.tab.id, message.discovery).catch((error) => {
            console.error(
              '[Service Worker] Failed to process passive caption discovery update:',
              formatError(error),
            );
          });
        }
        return false;
      case 'SET_CAPTION_CDP_MONITORING':
        handleSetCaptionCdpMonitoring(message.tabId, message.action, sendResponse);
        return true;
      case 'RETRIEVE_CAPTION_SOURCE':
        handleRetrieveCaptionSource(message.tabId, message.candidateId, sendResponse);
        return true;
      case 'GET_PLAYBACK_TRACE_STATE':
        void playbackTraceReady.then(() => {
          sendResponse({ success: true, state: getPlaybackTraceState(message.tabId) });
        });
        return true;
      case 'START_PLAYBACK_TRACE':
        void startPlaybackTrace(message.tabId)
          .then(sendResponse)
          .catch((error) => sendResponse({ success: false, error: formatError(error) }));
        return true;
      case 'STOP_PLAYBACK_TRACE':
        void stopPlaybackTrace(message.tabId, 'manual')
          .then(sendResponse)
          .catch((error) => sendResponse({ success: false, error: formatError(error) }));
        return true;
      case 'DELETE_PLAYBACK_TRACE':
        void deletePlaybackTrace()
          .then(sendResponse)
          .catch((error) => sendResponse({ success: false, error: formatError(error) }));
        return true;
      case 'EXPORT_PLAYBACK_TRACE':
        void exportPlaybackTrace()
          .then(sendResponse)
          .catch((error) => sendResponse({ success: false, error: formatError(error) }));
        return true;
      case 'PLAYBACK_TRACE_CONTENT_READY':
        if (sender.tab?.id !== undefined) {
          void playbackTraceReady.then(() => {
            if (
              playbackTrace?.state.phase === 'recording' &&
              playbackTrace.state.tabId === sender.tab?.id
            ) {
              chrome.tabs
                .sendMessage(sender.tab.id, { type: 'SET_PLAYBACK_TRACE_CONTENT', active: true })
                .catch((error) =>
                  console.warn(
                    '[Service Worker] Could not enable playback event capture:',
                    formatError(error),
                  ),
                );
            }
          });
        }
        return false;
      case 'PLAYBACK_TRACE_CONTENT_EVENT':
        if (sender.tab?.id !== undefined) {
          void playbackTraceReady.then(() => {
            if (
              playbackTrace?.state.phase === 'recording' &&
              playbackTrace.state.tabId === sender.tab?.id
            ) {
              appendPlaybackTraceEvent({
                category: message.event.name === 'page_click' ? 'interaction' : 'playback',
                name: message.event.name,
                mediaTime: message.event.mediaTime,
                previousMediaTime: message.event.previousMediaTime,
                mediaTimes: message.event.mediaTimes,
                interaction: message.event.interaction,
                duration: message.event.duration,
                paused: message.event.paused,
                detail: message.event.detail,
                timestamp: message.event.timestamp,
              });
            }
          });
        }
        return false;
      case 'UPDATE_SETTINGS':
        handleUpdateSettings(message.settings, sendResponse);
        return true;

      case 'REQUEST_STATE':
        handleRequestState(sendResponse);
        return true;

      case 'START_TAB_AUDIO_CAPTURE':
        handleStartTabAudioCapture(message.tabId, sendResponse);
        return true;

      case 'STOP_TAB_AUDIO_CAPTURE':
        pendingTabCaptureStop = sendResponse;
        chrome.runtime
          .sendMessage({ target: 'offscreen', type: 'STOP_TAB_AUDIO_CAPTURE' })
          .catch((error) => {
            pendingTabCaptureStop?.({ success: false, error: formatTabCaptureError(error) });
            pendingTabCaptureStop = undefined;
          });
        return true;

      case 'VIDEO_STATE_UPDATE':
        useExtensionStore.getState().setVideos(message.videos);
        broadcastState(sender.tab?.id);
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

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  void playbackTraceReady.then(() => {
    if (playbackTrace?.state.phase === 'recording' && playbackTrace.state.tabId === source.tabId) {
      void finishPlaybackTrace('debugger-detached', `Debugger detached: ${reason}`);
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(PLAYBACK_TRACE_ALARM_PREFIX)) return;
  void playbackTraceReady.then(() => {
    const traceId = alarm.name.slice(PLAYBACK_TRACE_ALARM_PREFIX.length);
    if (playbackTrace?.state.traceId === traceId && playbackTrace.state.phase === 'recording') {
      void finishPlaybackTrace('duration-limit');
    }
  });
});

// Listen for popup connection (long-lived port)
chrome.runtime.onConnect.addListener((port) => {
  console.log('[Service Worker] Port connected:', port.name);

  if (port.name === 'popup-port') {
    popupPorts.add(port);
    port.onDisconnect.addListener(() => popupPorts.delete(port));

    port.onMessage.addListener((message) => {
      if (message.type === 'REQUEST_STATE') {
        port.postMessage({
          type: 'STATE_UPDATED',
          state: useExtensionStore.getState(),
        });
      } else if (message.type === 'REQUEST_CAPTION_STATE') {
        void captionStateReady.then(() => {
          port.postMessage({
            type: 'CAPTION_STATE_UPDATED',
            state: getCaptionState(message.tabId),
          });
        });
      } else if (message.type === 'REQUEST_PLAYBACK_TRACE_STATE') {
        void playbackTraceReady.then(() => {
          const state = getPlaybackTraceState(message.tabId);
          if (state) port.postMessage({ type: 'PLAYBACK_TRACE_UPDATED', state });
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

chrome.tabs.onRemoved.addListener((tabId) => {
  captionCandidatesByTab.delete(tabId);
  cdpCandidatesByTab.delete(tabId);
  captionRetrievalsByTab.delete(tabId);
  captionPayloadsByTab.delete(tabId);
  captionStatesByTab.delete(tabId);
  retrievingCandidateIdsByTab.delete(tabId);
  captionDiscoveryTasksByTab.delete(tabId);
  debuggerCapturePausersByTab.get(tabId)?.();
  void persistCaptionStates();
});

function broadcastState(tabId?: number) {
  const state = useExtensionStore.getState();
  popupPorts.forEach((port) => port.postMessage({ type: 'STATE_UPDATED', state, tabId }));
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

function handleDiscoverCaptionSources(
  tabId: number,
  sendResponse: (data: CaptionDiscoveryResponse) => void,
) {
  void captionStateReady
    .then(async () => {
      const state = getCaptionState(tabId);
      if (state.phase === 'cdp-monitoring' || state.phase === 'cdp-paused') {
        sendResponse(
          state.discovery || createDiscoveryFailure('CDP monitoring is already in progress.'),
        );
        return;
      }
      let task = captionDiscoveryTasksByTab.get(tabId);
      if (!task) {
        task = discoverCaptionSources(tabId);
        captionDiscoveryTasksByTab.set(tabId, task);
      }
      try {
        sendResponse(await task);
      } finally {
        if (captionDiscoveryTasksByTab.get(tabId) === task) {
          captionDiscoveryTasksByTab.delete(tabId);
        }
      }
    })
    .catch((error) => {
      const failure = createDiscoveryFailure(`Caption discovery failed: ${formatError(error)}`);
      void updateCaptionState(tabId, 'failed', failure, formatError(error));
      sendResponse(failure);
    });
}

async function discoverCaptionSources(tabId: number): Promise<CaptionDiscoveryResponse> {
  await updateCaptionState(tabId, 'discovering', undefined, null);
  try {
    const passiveDiscovery = await requestCaptionDiscovery(tabId);
    const discovery =
      passiveDiscovery || createDiscoveryFailure('Passive page discovery was unavailable.');
    const current = getCaptionState(tabId);
    const merged: CaptionDiscoveryResponse = {
      ...discovery,
      capturedAt: new Date().toISOString(),
      candidates: mergeCaptionCandidates(
        tabId,
        mergePassiveCaptionCandidates(
          tabId,
          current.discovery?.candidates || [],
          discovery.candidates,
        ),
        cdpCandidatesByTab.get(tabId) || [],
      ),
    };
    await updateCaptionState(tabId, 'non-cdp-complete', merged, null);
    return merged;
  } catch (error) {
    const failure = createDiscoveryFailure(`Caption discovery failed: ${formatError(error)}`);
    await updateCaptionState(tabId, 'failed', failure, formatError(error));
    return failure;
  }
}

async function handleCaptionDiscoveryUpdate(
  tabId: number,
  incoming: CaptionDiscoveryResponse,
): Promise<void> {
  await captionStateReady;
  if (
    incoming.schemaVersion !== 1 ||
    !Array.isArray(incoming.candidates) ||
    !Array.isArray(incoming.limitations)
  ) {
    console.warn('[Service Worker] Ignored invalid passive caption discovery update.');
    return;
  }

  const current = getCaptionState(tabId);
  const merged: CaptionDiscoveryResponse = {
    ...incoming,
    capturedAt: new Date().toISOString(),
    candidates: mergeCaptionCandidates(
      tabId,
      mergePassiveCaptionCandidates(
        tabId,
        current.discovery?.candidates || [],
        incoming.candidates,
      ),
      cdpCandidatesByTab.get(tabId) || [],
    ),
    limitations: [...new Set([...(current.discovery?.limitations || []), ...incoming.limitations])],
  };
  const phase =
    current.phase === 'idle' || current.phase === 'failed' || current.phase === 'no-match'
      ? 'non-cdp-complete'
      : current.phase;
  await updateCaptionState(tabId, phase, merged, null);
}

function mergePassiveCaptionCandidates(
  tabId: number,
  existing: CaptionSourceCandidate[],
  incoming: CaptionSourceCandidate[],
): CaptionSourceCandidate[] {
  const merged = [...existing];
  incoming.forEach((candidate) => {
    const duplicateIndex = merged.findIndex((item) => {
      if (item.url && candidate.url) return item.url === candidate.url;
      if (!item.url && !candidate.url) {
        return (
          item.kind === candidate.kind &&
          item.videoId === candidate.videoId &&
          item.nativeTrackIndex === candidate.nativeTrackIndex
        );
      }
      return (
        item.kind === candidate.kind &&
        item.videoId === candidate.videoId &&
        Boolean(item.displayUrl && item.displayUrl === candidate.displayUrl)
      );
    });
    if (duplicateIndex < 0) {
      merged.push(candidate);
      return;
    }

    const current = merged[duplicateIndex];
    if (Boolean(current.url) === Boolean(candidate.url)) return;
    merged[duplicateIndex] = {
      ...current,
      ...candidate,
      id: current.id,
      url: current.url || candidate.url,
      displayUrl: candidate.displayUrl || current.displayUrl,
      evidence: [
        ...current.evidence,
        ...candidate.evidence.filter(
          (evidence) =>
            !current.evidence.some(
              (item) =>
                item.description === evidence.description &&
                item.selector === evidence.selector &&
                item.fieldPath === evidence.fieldPath,
            ),
        ),
      ],
    };
  });
  return ensureUniqueCandidateIds(tabId, merged);
}

function ensureUniqueCandidateIds(
  tabId: number,
  candidates: CaptionSourceCandidate[],
): CaptionSourceCandidate[] {
  const seen = new Set<string>();
  const ambiguousIds = new Set<string>();
  const uniqueCandidates = candidates.map((candidate) => {
    if (!seen.has(candidate.id)) {
      seen.add(candidate.id);
      return candidate;
    }

    ambiguousIds.add(candidate.id);
    const identity =
      candidate.url ||
      [
      candidate.kind,
      candidate.videoId,
      candidate.nativeTrackIndex ?? 'page',
      candidate.displayUrl || '',
    ].join(':');
    const baseId = `${candidate.id}-${hashCandidateIdentity(identity)}`;
    let uniqueId = baseId;
    let suffix = 2;
    while (seen.has(uniqueId)) {
      uniqueId = `${baseId}-${suffix++}`;
    }
    seen.add(uniqueId);
    return { ...candidate, id: uniqueId };
  });

  if (ambiguousIds.size > 0) {
    const retrievals = captionRetrievalsByTab.get(tabId);
    const payloads = captionPayloadsByTab.get(tabId);
    ambiguousIds.forEach((id) => {
      retrievals?.delete(id);
      payloads?.delete(id);
    });
  }
  return uniqueCandidates;
}

function hashCandidateIdentity(identity: string): string {
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function handleSetCaptionCdpMonitoring(
  tabId: number,
  action: 'start' | 'pause' | 'resume',
  sendResponse: (data: { success: boolean; state: CaptionCaptureState; error?: string }) => void,
) {
  void captionStateReady
    .then(async () => {
      const current = getCaptionState(tabId);
      if (action === 'pause') {
        if (current.phase !== 'cdp-monitoring') {
          sendResponse({ success: false, state: current, error: 'CDP monitoring is not active.' });
          return;
        }
        debuggerCapturePausersByTab.get(tabId)?.();
        const task = cdpCaptureTasksByTab.get(tabId);
        if (task) await task;
        const state = getCaptionState(tabId);
        sendResponse({
          success: state.phase === 'cdp-paused',
          state,
          error: state.phase === 'failed' ? state.error : undefined,
        });
        return;
      }
      if (current.phase === 'cdp-monitoring') {
        sendResponse({ success: true, state: current });
        return;
      }
      const discovery = current.discovery || captionCandidatesByTab.get(tabId);
      if (!discovery) {
        sendResponse({
          success: false,
          state: current,
          error: 'Find likely caption sources before starting CDP monitoring.',
        });
        return;
      }
      await updateCaptionState(tabId, 'cdp-monitoring', discovery, null);
      const task = completeCdpDiscovery(tabId, discovery);
      cdpCaptureTasksByTab.set(tabId, task);
      void task.finally(() => {
        if (cdpCaptureTasksByTab.get(tabId) === task) cdpCaptureTasksByTab.delete(tabId);
      });
      sendResponse({ success: true, state: getCaptionState(tabId) });
    })
    .catch((error) => {
      const message = formatError(error);
      void updateCaptionState(tabId, 'failed', captionCandidatesByTab.get(tabId), message);
      sendResponse({ success: false, state: getCaptionState(tabId), error: message });
    });
}

async function completeCdpDiscovery(tabId: number, discovery: CaptionDiscoveryResponse) {
  let captureResult: CdpCaptureResult = {
    payloads: [],
    responseCount: 0,
    bodyReadCount: 0,
    bodyReadFailures: 0,
    ignoredByReason: {},
  };
  let captureError: string | undefined;
  try {
    captureResult = await captureCaptionSourcesWithDebugger(tabId, discovery);
  } catch (error) {
    captureError = formatError(error);
  }
  const cdpCandidates = cdpCandidatesByTab.get(tabId) || [];
  captionCandidatesByTab.set(tabId, {
    ...discovery,
    capturedAt: new Date().toISOString(),
    candidates: mergeCaptionCandidates(
      tabId,
      discovery.candidates,
      cdpCandidatesByTab.get(tabId) || [],
    ),
    limitations: [
      ...discovery.limitations,
      'Network candidates were discovered by attaching CDP and reloading the tab.',
      ...(cdpCandidates.length
        ? []
        : ['No timed-text response body was captured during the reload.']),
      ...(captureError ? [`CDP capture failed: ${captureError}`] : []),
    ],
  });
  const diagnostics: CaptionCaptureDiagnostics = {
    responsesObserved: captureResult.responseCount,
    bodiesRead: captureResult.bodyReadCount,
    bodyReadFailures: captureResult.bodyReadFailures,
    candidatesAccepted: cdpCandidates.length,
    ignoredByReason: captureResult.ignoredByReason,
  };
  const phase: CaptionCapturePhase = captureResult.paused
    ? 'cdp-paused'
    : captureError
      ? 'failed'
      : cdpCandidates.length
        ? 'complete'
        : 'no-match';
  await updateCaptionState(
    tabId,
    phase,
    captionCandidatesByTab.get(tabId),
    captureError,
    diagnostics,
  );
}

async function recordCapturedCdpCandidate(
  tabId: number,
  discovery: CaptionDiscoveryResponse,
  item: CapturedCaptionPayload,
  diagnostics: CaptionCaptureDiagnostics,
) {
  const format = validateCaptionPayload(item.finalUrl, item.contentType, item.payload);
  if (!format) return;

  const isDataUrl = item.finalUrl.startsWith('data:');
  const candidateUrl = isDataUrl ? redactCaptionUrl(item.finalUrl) : item.finalUrl;
  const existingCandidate = isDataUrl
    ? undefined
    : (cdpCandidatesByTab.get(tabId) || []).find((candidate) => candidate.url === candidateUrl);
  if (existingCandidate) return;

  const candidate: CaptionSourceCandidate = {
    id: `caption-source-cdp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    videoId: discovery.candidates[0]?.videoId || 'unknown-video',
    kind: 'resource-url',
    format,
    url: candidateUrl,
    displayUrl: redactCaptionUrl(item.finalUrl),
    confidence: 'high',
    timing: 'exact',
    evidence: [
      { description: 'CDP captured and validated a timed-text response body.' },
      { description: `Response content type: ${item.contentType || 'unknown'}` },
    ],
  };
  cacheCaptionPayload(tabId, candidate.id, { ...item, finalUrl: candidateUrl });
  const cdpCandidates = [...(cdpCandidatesByTab.get(tabId) || []), candidate];
  cdpCandidatesByTab.set(tabId, cdpCandidates);
  const currentDiscovery = captionCandidatesByTab.get(tabId) || discovery;
  const updatedDiscovery: CaptionDiscoveryResponse = {
    ...currentDiscovery,
    capturedAt: new Date().toISOString(),
    candidates: mergeCaptionCandidates(tabId, currentDiscovery.candidates, [candidate]),
  };
  captionCandidatesByTab.set(tabId, updatedDiscovery);
  await updateCaptionState(tabId, 'cdp-monitoring', updatedDiscovery, null, {
    ...diagnostics,
    candidatesAccepted: cdpCandidates.length,
  });
}

function mergeCaptionCandidates(
  tabId: number,
  existing: CaptionSourceCandidate[],
  captured: CaptionSourceCandidate[],
): CaptionSourceCandidate[] {
  const merged = [...existing];
  captured.forEach((candidate) => {
    const existingIndex = merged.findIndex(
      (item) => item.url && candidate.url && item.url === candidate.url,
    );
    if (existingIndex < 0) {
      merged.push(candidate);
    } else {
      const existing = merged[existingIndex];
      if (existing.id) {
        const payload = captionPayloadsByTab.get(tabId)?.get(candidate.id);
        if (payload) cacheCaptionPayloadForCandidate(tabId, existing, payload);
      }
      merged[existingIndex] = {
        ...existing,
        format: candidate.format,
        confidence: 'high',
        timing: candidate.timing,
        evidence: [
          ...existing.evidence,
          ...candidate.evidence.filter(
            (evidence) =>
              !existing.evidence.some(
                (item) =>
                  item.description === evidence.description &&
                  item.selector === evidence.selector &&
                  item.fieldPath === evidence.fieldPath,
              ),
          ),
        ],
      };
    }
  });
  return ensureUniqueCandidateIds(tabId, merged);
}

function cacheCaptionPayloadForCandidate(
  tabId: number,
  target: CaptionSourceCandidate,
  payload: CapturedCaptionPayload,
) {
  const values = captionPayloadsByTab.get(tabId);
  if (!values) return;
  values.set(target.id, payload);
}

function createDiscoveryFailure(message: string): CaptionDiscoveryResponse {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    candidates: [],
    limitations: [message],
  };
}

async function restoreCaptionStates() {
  const stored = await chrome.storage.session.get(CAPTION_STATE_STORAGE_KEY);
  const persisted = stored[CAPTION_STATE_STORAGE_KEY] as
    Record<string, PersistedCaptionCaptureState> | undefined;
  if (!persisted) return;

  for (const [tabIdValue, state] of Object.entries(persisted)) {
    const tabId = Number(tabIdValue);
    if (!Number.isInteger(tabId) || !state || state.tabId !== tabId) continue;
    captionStatesByTab.set(tabId, state);
    if (state.discovery) captionCandidatesByTab.set(tabId, state.discovery);
    cdpCandidatesByTab.set(tabId, state.cdpCandidates || []);
    captionRetrievalsByTab.set(tabId, new Map(Object.entries(state.retrievals || {})));
    captionPayloadsByTab.set(tabId, new Map(Object.entries(state.payloads || {})));
  }
}

function getCaptionState(tabId: number): CaptionCaptureState {
  const existing = captionStatesByTab.get(tabId);
  return {
    tabId,
    phase: existing?.phase || 'idle',
    discovery: captionCandidatesByTab.get(tabId) || existing?.discovery,
    retrievals: Object.fromEntries(captionRetrievalsByTab.get(tabId) || []),
    retrievingCandidateIds: [...(retrievingCandidateIdsByTab.get(tabId) || [])],
    diagnostics: existing?.diagnostics || createEmptyCaptionDiagnostics(),
    error: existing?.error,
    updatedAt: existing?.updatedAt || new Date().toISOString(),
  };
}

async function updateCaptionState(
  tabId: number,
  phase: CaptionCapturePhase,
  discovery?: CaptionDiscoveryResponse,
  error?: string | null,
  diagnostics?: CaptionCaptureDiagnostics,
): Promise<CaptionCaptureState> {
  if (discovery) captionCandidatesByTab.set(tabId, discovery);
  const previous = captionStatesByTab.get(tabId);
  const state: CaptionCaptureState = {
    tabId,
    phase,
    discovery: discovery || captionCandidatesByTab.get(tabId) || previous?.discovery,
    retrievals: Object.fromEntries(captionRetrievalsByTab.get(tabId) || []),
    retrievingCandidateIds: [...(retrievingCandidateIdsByTab.get(tabId) || [])],
    diagnostics: diagnostics || previous?.diagnostics || createEmptyCaptionDiagnostics(),
    error: error === null ? undefined : (error ?? previous?.error),
    updatedAt: new Date().toISOString(),
  };
  captionStatesByTab.set(tabId, state);
  broadcastCaptionState(state);
  await persistCaptionStates();
  return state;
}

function createEmptyCaptionDiagnostics(): CaptionCaptureDiagnostics {
  return {
    responsesObserved: 0,
    bodiesRead: 0,
    bodyReadFailures: 0,
    candidatesAccepted: 0,
    ignoredByReason: {},
  };
}

function broadcastCaptionState(state: CaptionCaptureState) {
  popupPorts.forEach((port) => port.postMessage({ type: 'CAPTION_STATE_UPDATED', state }));
}

function persistCaptionStates(): Promise<void> {
  const persisted: Record<string, PersistedCaptionCaptureState> = {};
  for (const tabId of captionStatesByTab.keys()) {
    persisted[String(tabId)] = {
      ...getCaptionState(tabId),
      cdpCandidates: cdpCandidatesByTab.get(tabId) || [],
      payloads: Object.fromEntries(captionPayloadsByTab.get(tabId) || []),
    };
  }
  captionPersistenceQueue = captionPersistenceQueue
    .catch(() => undefined)
    .then(() => chrome.storage.session.set({ [CAPTION_STATE_STORAGE_KEY]: persisted }))
    .catch((error) => {
      console.error('[Service Worker] Failed to persist caption state:', formatError(error));
    });
  return captionPersistenceQueue;
}

async function handleRetrieveCaptionSource(
  tabId: number,
  candidateId: string,
  sendResponse: (data: CaptionRetrievalResponse) => void,
) {
  await captionStateReady;
  const retrieving = retrievingCandidateIdsByTab.get(tabId) || new Set<string>();
  if (retrieving.has(candidateId)) {
    sendResponse({
      success: false,
      candidateId,
      warnings: [],
      failure: {
        category: 'timeout',
        message:
          'Caption retrieval is already in progress. Its result will appear when it finishes.',
      },
    });
    return;
  }
  retrieving.add(candidateId);
  retrievingCandidateIdsByTab.set(tabId, retrieving);
  const currentState = getCaptionState(tabId);
  await updateCaptionState(tabId, currentState.phase, currentState.discovery);
  const finishRetrieval = (result: CaptionRetrievalResponse) => {
    cacheCaptionRetrieval(tabId, candidateId, result);
    sendResponse(result);
  };
  try {
    let discovery = captionCandidatesByTab.get(tabId);
    if (!discovery) discovery = await requestCaptionDiscovery(tabId);
    const discoveredCandidate = discovery?.candidates.find(({ id }) => id === candidateId);
    if (!discoveredCandidate) {
      finishRetrieval({
        success: false,
        candidateId,
        warnings: [],
        failure: {
          category: 'inaccessible',
          message: 'Caption source was not discovered for this tab.',
        },
      });
      return;
    }
    const candidate = discoveredCandidate;
    const cachedResult = captionRetrievalsByTab.get(tabId)?.get(candidateId);
    if (cachedResult?.success) {
      sendResponse(cachedResult);
      return;
    }
    if (!candidate.url && candidate.kind !== 'native-track') {
      finishRetrieval({
        success: false,
        candidateId,
        warnings: [],
        failure: {
          category: 'inaccessible',
          message: 'Caption candidate does not expose a fetchable URL.',
        },
      });
      return;
    }

    const cachedPayload = captionPayloadsByTab.get(tabId)?.get(candidateId);
    if (!cachedPayload) {
      const result = await new Promise<CaptionRetrievalResponse>((resolve, reject) => {
        chrome.tabs.sendMessage(
          tabId,
          { type: 'RETRIEVE_CAPTION_SOURCE_IN_PAGE', candidate },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!isCaptionRetrievalResponse(response, candidateId)) {
              reject(new Error('Content script returned an invalid caption retrieval response.'));
              return;
            }
            resolve(response);
          },
        );
      });
      finishRetrieval(result);
      return;
    }

    const captured = cachedPayload;
    cacheCaptionPayload(tabId, candidateId, captured);
    const format = detectCaptionFormat(candidate.url, captured.contentType, captured.payload);
    const raw = {
      candidateId,
      format,
      filename: createCaptionFilename(candidate, format),
      contentType: captured.contentType,
      payload: captured.payload,
      byteLength: captured.byteLength,
    };
    try {
      const normalized = normalizeCaptionPayload(
        captured.payload,
        { ...candidate, format },
        {
          contentType: captured.contentType,
          sourceUrl: captured.finalUrl,
          byteLength: captured.byteLength,
        },
      );
      const result = { success: true, candidateId, raw, normalized, warnings: normalized.warnings };
      finishRetrieval(result);
    } catch (error) {
      const result = {
        success: false,
        candidateId,
        raw,
        warnings: [],
        failure: {
          category: 'unsupported-format',
          message: formatError(error),
          diagnostics: { stage: 'payload-validation' as const },
        },
      } as CaptionRetrievalResponse;
      finishRetrieval(result);
    }
  } catch (error) {
    const result: CaptionRetrievalResponse = {
      success: false,
      candidateId,
      warnings: [],
      failure: {
        category: classifyFetchFailure(error),
        message: formatError(error),
        diagnostics: { stage: 'content-script-bridge' },
      },
    };
    finishRetrieval(result);
  } finally {
    retrieving.delete(candidateId);
    if (retrieving.size === 0) retrievingCandidateIdsByTab.delete(tabId);
    const state = getCaptionState(tabId);
    await updateCaptionState(tabId, state.phase, state.discovery);
  }
}

async function restorePlaybackTrace(): Promise<void> {
  const stored = await chrome.storage.local.get(PLAYBACK_TRACE_META_KEY);
  const state = stored[PLAYBACK_TRACE_META_KEY] as PlaybackTraceState | undefined;
  if (!state) return;

  const chunkCount = Math.ceil(state.eventCount / PLAYBACK_TRACE_CHUNK_SIZE);
  const chunkKeys = Array.from({ length: chunkCount }, (_, index) =>
    getPlaybackTraceChunkKey(state.traceId, index),
  );
  const storedChunks = chunkKeys.length ? await chrome.storage.local.get(chunkKeys) : {};
  const events: PlaybackTraceEvent[] = [];
  chunkKeys.forEach((key) => {
    const chunk = storedChunks[key];
    if (Array.isArray(chunk)) events.push(...(chunk as PlaybackTraceEvent[]));
  });
  events.sort((left, right) => left.sequence - right.sequence);

  playbackTrace = {
    state: { ...state },
    events: events.slice(0, state.eventCount),
    stopping: false,
    debuggerAttached: false,
    persistenceQueue: Promise.resolve(),
    lastPersistedEventCount: Math.min(events.length, state.eventCount),
    pendingUpdates: 0,
    pendingResponseCaptures: new Set(),
  };
  playbackTraceRequestsByTab.set(state.tabId, new Map());

  if (playbackTrace.state.phase !== 'recording') return;

  const elapsedMs = Date.now() - Date.parse(playbackTrace.state.startedAt);
  if (elapsedMs >= PLAYBACK_TRACE_MAX_DURATION_MS) {
    await finishPlaybackTrace('duration-limit');
    return;
  }

  try {
    attachPlaybackTraceEventListener(playbackTrace);
    playbackTrace.debuggerAttached = true;
    await chrome.debugger.sendCommand({ tabId: state.tabId }, 'Network.enable');
    chrome.alarms.create(`${PLAYBACK_TRACE_ALARM_PREFIX}${state.traceId}`, {
      when: Date.parse(state.startedAt) + PLAYBACK_TRACE_MAX_DURATION_MS,
    });
    await chrome.tabs
      .sendMessage(state.tabId, {
        type: 'SET_PLAYBACK_TRACE_CONTENT',
        active: true,
      })
      .catch((error) =>
        console.warn(
          '[Service Worker] Content script is unavailable while restoring trace:',
          formatError(error),
        ),
      );
    broadcastPlaybackTraceState();
  } catch (error) {
    await finishPlaybackTrace(
      'debugger-detached',
      `Could not resume trace after worker restart: ${formatError(error)}`,
    );
  }
}

async function startPlaybackTrace(tabId: number): Promise<PlaybackTraceResponse> {
  await playbackTraceReady;
  if (playbackTrace) {
    return {
      success: false,
      state: { ...playbackTrace.state },
      error:
        'A saved playback trace already exists. Export it and delete it before starting another.',
    };
  }
  if (debuggerCapturesByTab.has(tabId)) {
    return { success: false, error: 'Caption CDP monitoring is already active for this tab.' };
  }

  const startedAt = new Date().toISOString();
  const state: PlaybackTraceState = {
    traceId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    tabId,
    phase: 'recording',
    startedAt,
    elapsedMs: 0,
    eventCount: 0,
    serializedBytes: 0,
    bodyBytes: 0,
  };
  playbackTrace = {
    state,
    events: [],
    stopping: false,
    debuggerAttached: false,
    persistenceQueue: Promise.resolve(),
    lastPersistedEventCount: 0,
    pendingUpdates: 0,
    pendingResponseCaptures: new Set(),
  };
  playbackTraceRequestsByTab.set(tabId, new Map());

  const debuggee = { tabId };
  try {
    await persistPlaybackTrace();
    await chrome.debugger.attach(debuggee, '1.3');
    playbackTrace.debuggerAttached = true;
    attachPlaybackTraceEventListener(playbackTrace);
    await chrome.debugger.sendCommand(debuggee, 'Network.enable');
    chrome.alarms.create(`${PLAYBACK_TRACE_ALARM_PREFIX}${state.traceId}`, {
      when: Date.now() + PLAYBACK_TRACE_MAX_DURATION_MS,
    });
    appendPlaybackTraceEvent({ category: 'trace', name: 'trace_started' });
    await persistPlaybackTrace();
    chrome.tabs
      .sendMessage(tabId, { type: 'SET_PLAYBACK_TRACE_CONTENT', active: true })
      .catch((error) =>
        console.warn(
          '[Service Worker] Content script is not ready yet; playback trace will enable it when available:',
          formatError(error),
        ),
      );
    broadcastPlaybackTraceState();
    return { success: true, state: { ...state } };
  } catch (error) {
    await finishPlaybackTrace('error', formatError(error));
    return { success: false, state: { ...state }, error: formatError(error) };
  }
}

async function stopPlaybackTrace(
  tabId: number,
  reason: PlaybackTraceEndReason,
): Promise<PlaybackTraceResponse> {
  await playbackTraceReady;
  if (!playbackTrace || playbackTrace.state.tabId !== tabId) {
    return { success: false, error: 'There is no active playback trace for this tab.' };
  }
  if (playbackTrace.state.phase === 'recording') await finishPlaybackTrace(reason);
  return { success: true, state: { ...playbackTrace.state } };
}

function getPlaybackTraceState(tabId?: number): PlaybackTraceState | undefined {
  void tabId;
  if (!playbackTrace) return;
  updatePlaybackTraceElapsed();
  return { ...playbackTrace.state };
}

async function exportPlaybackTrace(): Promise<PlaybackTraceResponse> {
  await playbackTraceReady;
  if (!playbackTrace || playbackTrace.state.phase === 'recording') {
    return { success: false, error: 'Stop the playback trace before exporting it.' };
  }
  return {
    success: true,
    state: { ...playbackTrace.state },
    events: [...playbackTrace.events],
  };
}

async function deletePlaybackTrace(): Promise<PlaybackTraceResponse> {
  await playbackTraceReady;
  if (!playbackTrace) return { success: true };
  if (playbackTrace.state.phase === 'recording') {
    return { success: false, error: 'Stop the playback trace before deleting it.' };
  }
  const keys = [
    PLAYBACK_TRACE_META_KEY,
    ...Array.from(
      { length: Math.ceil(playbackTrace.state.eventCount / PLAYBACK_TRACE_CHUNK_SIZE) },
      (_, index) => getPlaybackTraceChunkKey(playbackTrace!.state.traceId, index),
    ),
  ];
  await chrome.storage.local.remove(keys);
  chrome.alarms.clear(`${PLAYBACK_TRACE_ALARM_PREFIX}${playbackTrace.state.traceId}`);
  playbackTrace = undefined;
  return { success: true };
}

async function finishPlaybackTrace(reason: PlaybackTraceEndReason, error?: string): Promise<void> {
  const record = playbackTrace;
  if (!record || record.state.phase !== 'recording' || record.stopping) return;
  record.stopping = true;
  chrome.alarms.clear(`${PLAYBACK_TRACE_ALARM_PREFIX}${record.state.traceId}`);
  playbackTraceRequestsByTab.delete(record.state.tabId);
  if (record.debuggerEventListener) {
    chrome.debugger.onEvent.removeListener(record.debuggerEventListener);
    record.debuggerEventListener = undefined;
  }
  try {
    await chrome.tabs.sendMessage(record.state.tabId, {
      type: 'SET_PLAYBACK_TRACE_CONTENT',
      active: false,
    });
  } catch (sendError) {
    console.warn(
      '[Service Worker] Could not stop content-script trace events:',
      formatError(sendError),
    );
  }
  await Promise.allSettled([...record.pendingResponseCaptures]);
  if (record.debuggerAttached) {
    const debuggee = { tabId: record.state.tabId };
    await chrome.debugger
      .sendCommand(debuggee, 'Network.disable')
      .catch((disableError) =>
        console.warn(
          '[Service Worker] Could not disable trace network events:',
          formatError(disableError),
        ),
      );
    await chrome.debugger
      .detach(debuggee)
      .catch((detachError) =>
        console.warn(
          '[Service Worker] Could not detach playback trace debugger:',
          formatError(detachError),
        ),
      );
    record.debuggerAttached = false;
  }
  record.state.endedAt = new Date().toISOString();
  record.state.elapsedMs = Math.max(0, Date.now() - Date.parse(record.state.startedAt));
  record.state.endReason = reason;
  record.state.phase =
    reason === 'manual'
      ? 'completed'
      : reason === 'duration-limit' || reason === 'event-limit' || reason === 'size-limit'
        ? 'limit-ended'
        : 'failed';
  if (error) record.state.error = error;
  await persistPlaybackTrace();
  broadcastPlaybackTraceState();
}

function appendPlaybackTraceEvent(
  input: Omit<PlaybackTraceEvent, 'sequence' | 'elapsedMs' | 'timestamp'> & {
    timestamp?: string;
  },
): boolean {
  const record = playbackTrace;
  if (!record || record.state.phase !== 'recording') return false;
  const event: PlaybackTraceEvent = {
    ...input,
    sequence: record.events.length + 1,
    timestamp: input.timestamp || new Date().toISOString(),
    elapsedMs: Math.max(0, Date.now() - Date.parse(record.state.startedAt)),
  };
  const atCapacityPressure =
    record.state.warning !== undefined ||
    record.state.serializedBytes >= PLAYBACK_TRACE_MAX_BYTES * PLAYBACK_TRACE_WARNING_RATIO ||
    record.state.eventCount >= PLAYBACK_TRACE_MAX_EVENTS * PLAYBACK_TRACE_WARNING_RATIO;
  if (atCapacityPressure && tryCoalescePlaybackTraceEvent(record, event)) {
    const previousWarning = record.state.warning;
    updatePlaybackTraceWarning(record);
    if (record.state.warning && !previousWarning) {
      broadcastPlaybackTraceState();
      void persistPlaybackTrace().catch((error) => {
        console.error('[Service Worker] Failed to persist playback trace:', formatError(error));
        void finishPlaybackTrace('error', `Trace persistence failed: ${formatError(error)}`);
      });
    }
    record.pendingUpdates += 1;
    if (record.pendingUpdates >= PLAYBACK_TRACE_PERSIST_BATCH_SIZE) {
      void persistPlaybackTrace().catch((error) => {
        console.error('[Service Worker] Failed to persist playback trace:', formatError(error));
        void finishPlaybackTrace('error', `Trace persistence failed: ${formatError(error)}`);
      });
    }
    return true;
  }

  const eventSize = getPlaybackTraceEventSize(event);
  const capReason = getPlaybackTraceLimitReason(
    record.state.eventCount,
    record.state.serializedBytes,
    eventSize,
  );
  if (capReason) {
    void finishPlaybackTrace(capReason);
    return false;
  }

  record.events.push(event);
  record.state.eventCount += 1;
  record.state.serializedBytes += eventSize;
  record.state.elapsedMs = event.elapsedMs;
  record.pendingUpdates += 1;
  const previousWarning = record.state.warning;
  updatePlaybackTraceWarning(record);
  if (record.state.warning && !previousWarning) {
    broadcastPlaybackTraceState();
    void persistPlaybackTrace().catch((error) => {
      console.error('[Service Worker] Failed to persist playback trace:', formatError(error));
      void finishPlaybackTrace('error', `Trace persistence failed: ${formatError(error)}`);
    });
  }
  const isHighPriorityEvent =
    event.category === 'trace' ||
    event.category === 'user' ||
    event.category === 'interaction' ||
    (event.category === 'playback' && event.name !== 'time_sample');
  if (isHighPriorityEvent || record.pendingUpdates >= PLAYBACK_TRACE_PERSIST_BATCH_SIZE) {
    void persistPlaybackTrace().catch((error) => {
      console.error('[Service Worker] Failed to persist playback trace:', formatError(error));
      void finishPlaybackTrace('error', `Trace persistence failed: ${formatError(error)}`);
    });
  }
  return true;
}

function tryCoalescePlaybackTraceEvent(
  record: PlaybackTraceRecord,
  event: PlaybackTraceEvent,
): boolean {
  if (event.category !== 'network' || !['request', 'response'].includes(event.name)) return false;
  const eventTime = Date.parse(event.timestamp);
  const currentChunkStart =
    Math.floor(Math.max(0, record.events.length - 1) / PLAYBACK_TRACE_CHUNK_SIZE) *
    PLAYBACK_TRACE_CHUNK_SIZE;
  const match = record.events
    .slice(currentChunkStart)
    .reverse()
    .find(
      (candidate) =>
        candidate.category === event.category &&
        candidate.name === event.name &&
        candidate.url === event.url &&
        candidate.method === event.method &&
        candidate.resourceType === event.resourceType &&
        candidate.status === event.status &&
        candidate.mimeType === event.mimeType &&
        eventTime - Date.parse(candidate.lastRepeatedAt || candidate.timestamp) >= 0 &&
        eventTime - Date.parse(candidate.lastRepeatedAt || candidate.timestamp) <= 30_000,
    );
  if (!match) return false;

  const priorSize = getPlaybackTraceEventSize(match);
  const updated: PlaybackTraceEvent = {
    ...match,
    repeatCount: (match.repeatCount || 1) + 1,
    lastRepeatedAt: event.timestamp,
  };
  const updatedSize = getPlaybackTraceEventSize(updated);
  if (record.state.serializedBytes - priorSize + updatedSize > PLAYBACK_TRACE_MAX_BYTES) {
    void finishPlaybackTrace('size-limit');
    return true;
  }
  Object.assign(match, updated);
  record.state.serializedBytes += updatedSize - priorSize;
  record.state.elapsedMs = event.elapsedMs;
  return true;
}

function updatePlaybackTraceWarning(record: PlaybackTraceRecord): void {
  if (record.state.warning) return;
  if (record.state.serializedBytes >= PLAYBACK_TRACE_MAX_BYTES * PLAYBACK_TRACE_WARNING_RATIO) {
    record.state.warning = 'Trace is approaching its serialized-size limit.';
  } else if (record.state.eventCount >= PLAYBACK_TRACE_MAX_EVENTS * PLAYBACK_TRACE_WARNING_RATIO) {
    record.state.warning = 'Trace is approaching its event-count limit.';
  }
}

function updatePlaybackTraceElapsed(): void {
  if (playbackTrace?.state.phase === 'recording') {
    playbackTrace.state.elapsedMs = Math.max(
      0,
      Date.now() - Date.parse(playbackTrace.state.startedAt),
    );
  }
}

function getPlaybackTraceChunkKey(traceId: string, index: number): string {
  return `playbackTraceEvents:${traceId}:${index}`;
}

function persistPlaybackTrace(): Promise<void> {
  const record = playbackTrace;
  if (!record) return Promise.resolve();
  updatePlaybackTraceElapsed();
  const snapshot = { ...record.state };
  const eventCount = record.events.length;
  const pendingUpdates = record.pendingUpdates;
  const chunkIndex = eventCount ? Math.floor((eventCount - 1) / PLAYBACK_TRACE_CHUNK_SIZE) : -1;
  const chunkStart = chunkIndex < 0 ? 0 : chunkIndex * PLAYBACK_TRACE_CHUNK_SIZE;
  const currentChunk = chunkIndex < 0 ? [] : record.events.slice(chunkStart, eventCount);
  record.persistenceQueue = record.persistenceQueue.then(async () => {
    const changes: Record<string, unknown> = { [PLAYBACK_TRACE_META_KEY]: snapshot };
    if (chunkIndex >= 0) {
      changes[getPlaybackTraceChunkKey(snapshot.traceId, chunkIndex)] = currentChunk;
    }
    await chrome.storage.local.set(changes);
    record.lastPersistedEventCount = eventCount;
    record.pendingUpdates = Math.max(0, record.pendingUpdates - pendingUpdates);
    broadcastPlaybackTraceState();
  });
  return record.persistenceQueue;
}

function broadcastPlaybackTraceState(): void {
  if (!playbackTrace) return;
  updatePlaybackTraceElapsed();
  const message = { type: 'PLAYBACK_TRACE_UPDATED', state: { ...playbackTrace.state } };
  popupPorts.forEach((port) => {
    try {
      port.postMessage(message);
    } catch (error) {
      console.warn('[Service Worker] Could not update popup trace state:', formatError(error));
    }
  });
}

function handlePlaybackTraceDebuggerEvent(tabId: number, method: string, params?: object): void {
  if (
    !params ||
    !playbackTrace ||
    playbackTrace.state.phase !== 'recording' ||
    playbackTrace.state.tabId !== tabId
  ) {
    return;
  }

  if (method === 'Network.requestWillBeSent') {
    const event = params as {
      requestId?: string;
      request?: { url?: string; method?: string };
      type?: string;
      initiator?: { type?: string };
    };
    const url = event.request?.url;
    if (!url || !isTraceResourceType(event.type)) return;
    if (event.requestId) {
      let requests = playbackTraceRequestsByTab.get(tabId);
      if (!requests) {
        requests = new Map();
        playbackTraceRequestsByTab.set(tabId, requests);
      }
      if (requests.size >= 10_000) {
        const oldestRequestId = requests.keys().next().value;
        if (oldestRequestId) requests.delete(oldestRequestId);
      }
      requests.set(event.requestId, {
        url,
        method: event.request?.method,
        resourceType: event.type,
      });
    }
    appendPlaybackTraceEvent({
      category: 'network',
      name: 'request',
      url: redactPlaybackTraceUrl(url),
      method: event.request?.method,
      resourceType: event.type,
      detail: event.initiator?.type ? `initiator:${event.initiator.type}` : undefined,
    });
    return;
  }

  if (method === 'Network.responseReceived') {
    const event = params as {
      requestId?: string;
      type?: string;
      response?: {
        url?: string;
        status?: number;
        mimeType?: string;
        headers?: Record<string, string>;
      };
    };
    const url = event.response?.url;
    const request = event.requestId
      ? playbackTraceRequestsByTab.get(tabId)?.get(event.requestId)
      : undefined;
    if (
      !url ||
      !isTraceResourceType(event.type) ||
      (event.requestId && !request)
    )
      return;
    if (request) {
      request.url = url;
      request.resourceType = event.type;
      request.status = event.response?.status;
      request.mimeType = event.response?.mimeType;
      const contentLength = Object.entries(event.response?.headers || {}).find(
        ([name]) => name.toLowerCase() === 'content-length',
      )?.[1];
      if (contentLength && /^\d+$/.test(contentLength)) {
        request.contentLength = Number(contentLength);
      }
    }
    appendPlaybackTraceEvent({
      category: 'network',
      name: 'response',
      url: redactPlaybackTraceUrl(url),
      resourceType: event.type,
      status: event.response?.status,
      mimeType: event.response?.mimeType,
    });
    return;
  }

  if (method === 'Network.loadingFinished') {
    const event = params as { requestId?: string; encodedDataLength?: number };
    const request = event.requestId
      ? playbackTraceRequestsByTab.get(tabId)?.get(event.requestId)
      : undefined;
    if (!event.requestId || !request) return;
    request.encodedDataLength = event.encodedDataLength;
    playbackTraceRequestsByTab.get(tabId)?.delete(event.requestId);
    appendPlaybackTraceEvent({
      category: 'network',
      name: 'request_finished',
      encodedDataLength: event.encodedDataLength,
    });
    if (request.status && request.status >= 200 && request.status < 300) {
      const capture = isPotentialPlaybackManifest(request.url, request.mimeType)
        ? capturePlaybackManifest(tabId, event.requestId, request)
        : captureYouTubeAdResponse(tabId, event.requestId, request);
      const record = playbackTrace;
      if (record) {
        record.pendingResponseCaptures.add(capture);
        void capture.finally(() => record.pendingResponseCaptures.delete(capture)).catch((error) => {
          console.error('[Service Worker] Playback response capture failed:', formatError(error));
        });
      }
    }
    return;
  }

  if (method === 'Network.loadingFailed') {
    const event = params as { requestId?: string };
    if (!event.requestId || !playbackTraceRequestsByTab.get(tabId)?.delete(event.requestId)) return;
    appendPlaybackTraceEvent({ category: 'network', name: 'request_failed' });
  }
}

async function capturePlaybackManifest(
  tabId: number,
  requestId: string,
  request: PlaybackTraceRequest,
): Promise<void> {
  if (!isPotentialPlaybackManifest(request.url, request.mimeType)) return;
  const record = playbackTrace;
  if (!record || record.state.phase !== 'recording' || record.state.tabId !== tabId) return;

  if (
    (request.contentLength && request.contentLength > PLAYBACK_TRACE_MAX_MANIFEST_BYTES) ||
    (request.encodedDataLength && request.encodedDataLength > PLAYBACK_TRACE_MAX_MANIFEST_BYTES)
  ) {
    appendPlaybackTraceEvent({
      category: 'network',
      name: 'manifest_capture_skipped',
      url: redactPlaybackTraceUrl(request.url),
      resourceType: request.resourceType,
      status: request.status,
      mimeType: request.mimeType,
      detail: 'manifest-over-per-document-limit',
    });
    return;
  }

  let source: string;
  try {
    const responseBody = (await chrome.debugger.sendCommand(
      { tabId },
      'Network.getResponseBody',
      { requestId },
    )) as { body: string; base64Encoded?: boolean };
    source = responseBody.base64Encoded ? decodeBase64Utf8(responseBody.body) : responseBody.body;
  } catch (error) {
    console.warn('[Service Worker] Could not read candidate manifest body:', formatError(error));
    appendPlaybackTraceEvent({
      category: 'network',
      name: 'manifest_capture_skipped',
      url: redactPlaybackTraceUrl(request.url),
      resourceType: request.resourceType,
      status: request.status,
      mimeType: request.mimeType,
      detail: 'response-body-unavailable',
    });
    return;
  }

  if (new TextEncoder().encode(source).byteLength > PLAYBACK_TRACE_MAX_MANIFEST_BYTES) {
    appendPlaybackTraceEvent({
      category: 'network',
      name: 'manifest_capture_skipped',
      url: redactPlaybackTraceUrl(request.url),
      resourceType: request.resourceType,
      status: request.status,
      mimeType: request.mimeType,
      detail: 'manifest-over-per-document-limit',
    });
    return;
  }
  const manifest = sanitizePlaybackManifest(source);
  if (!manifest) {
    appendPlaybackTraceEvent({
      category: 'network',
      name: 'manifest_capture_skipped',
      url: redactPlaybackTraceUrl(request.url),
      resourceType: request.resourceType,
      status: request.status,
      mimeType: request.mimeType,
      detail: 'response-was-not-a-supported-manifest',
    });
    return;
  }
  if (record.state.bodyBytes + manifest.byteLength > PLAYBACK_TRACE_MAX_BODY_BYTES) {
    appendPlaybackTraceEvent({
      category: 'network',
      name: 'manifest_capture_skipped',
      url: redactPlaybackTraceUrl(request.url),
      resourceType: request.resourceType,
      status: request.status,
      mimeType: request.mimeType,
      detail: 'manifest-body-budget-exhausted',
    });
    return;
  }

  const added = appendPlaybackTraceEvent({
    category: 'network',
    name: 'manifest_captured',
    url: redactPlaybackTraceUrl(request.url),
    method: request.method,
    resourceType: request.resourceType,
    status: request.status,
    mimeType: request.mimeType,
    manifestFormat: manifest.format,
    manifestText: manifest.text,
  });
  if (added) {
    record.state.bodyBytes += manifest.byteLength;
    void persistPlaybackTrace().catch((error) => {
      console.error('[Service Worker] Failed to persist captured manifest:', formatError(error));
      void finishPlaybackTrace('error', `Manifest persistence failed: ${formatError(error)}`);
    });
  }
}

async function captureYouTubeAdResponse(
  tabId: number,
  requestId: string,
  request: PlaybackTraceRequest,
): Promise<void> {
  const responseKind = getYouTubeAdResponseKind(request.url, request.mimeType);
  if (!responseKind) return;
  const record = playbackTrace;
  if (!record || record.state.phase !== 'recording' || record.state.tabId !== tabId) return;
  const responseSizeKnown =
    request.contentLength !== undefined || request.encodedDataLength !== undefined;
  const byteLength = Math.max(request.contentLength ?? 0, request.encodedDataLength ?? 0);
  if (!responseSizeKnown || byteLength > PLAYBACK_TRACE_MAX_YOUTUBE_RESPONSE_BYTES) {
    appendPlaybackTraceEvent({
      category: 'network',
      name: 'youtube_ad_response_skipped',
      url: redactPlaybackTraceUrl(request.url),
      method: request.method,
      resourceType: request.resourceType,
      status: request.status,
      mimeType: request.mimeType,
      encodedDataLength: request.encodedDataLength,
      detail: byteLength === undefined ? 'response-size-unavailable' : 'response-over-size-limit',
    });
    return;
  }

  let source: string;
  try {
    const responseBody = (await chrome.debugger.sendCommand(
      { tabId },
      'Network.getResponseBody',
      { requestId },
    )) as { body: string; base64Encoded?: boolean };
    source = responseBody.base64Encoded ? decodeBase64Utf8(responseBody.body) : responseBody.body;
  } catch (error) {
    console.warn('[Service Worker] Could not read YouTube ad response:', formatError(error));
    appendPlaybackTraceEvent({
      category: 'network',
      name: 'youtube_ad_response_skipped',
      url: redactPlaybackTraceUrl(request.url),
      method: request.method,
      resourceType: request.resourceType,
      status: request.status,
      mimeType: request.mimeType,
      detail: 'response-body-unavailable',
    });
    return;
  }

  if (new TextEncoder().encode(source).byteLength > PLAYBACK_TRACE_MAX_YOUTUBE_RESPONSE_BYTES) {
    appendPlaybackTraceEvent({
      category: 'network',
      name: 'youtube_ad_response_skipped',
      url: redactPlaybackTraceUrl(request.url),
      method: request.method,
      resourceType: request.resourceType,
      status: request.status,
      mimeType: request.mimeType,
      encodedDataLength: request.encodedDataLength,
      detail: 'response-over-size-limit',
    });
    return;
  }

  const summary = summarizeYouTubeAdResponse(source);
  if (!summary) {
    appendPlaybackTraceEvent({
      category: 'network',
      name: 'youtube_ad_response_skipped',
      url: redactPlaybackTraceUrl(request.url),
      method: request.method,
      resourceType: request.resourceType,
      status: request.status,
      mimeType: request.mimeType,
      encodedDataLength: request.encodedDataLength,
      detail: 'response-was-not-json-object',
    });
    return;
  }

  appendPlaybackTraceEvent({
    category: 'network',
    name: 'youtube_ad_response_summary',
    url: redactPlaybackTraceUrl(request.url),
    method: request.method,
    resourceType: request.resourceType,
    status: request.status,
    mimeType: request.mimeType,
    encodedDataLength: request.encodedDataLength,
    detail: responseKind,
    responseSummary: summary.fields,
    summaryTruncated: summary.truncated,
  });
}

function getYouTubeAdResponseKind(url: string, mimeType?: string): 'get_watch' | 'ad_break' | undefined {
  if (mimeType?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return;
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();
    if (hostname !== 'youtube.com' && !hostname.endsWith('.youtube.com')) return;
    if (parsedUrl.pathname === '/youtubei/v1/get_watch') return 'get_watch';
    if (parsedUrl.pathname === '/youtubei/v1/player/ad_break') return 'ad_break';
  } catch {
    return;
  }
}

function isPotentialPlaybackManifest(url: string, mimeType?: string): boolean {
  const normalizedMimeType = mimeType?.split(';', 1)[0].trim().toLowerCase();
  if (
    normalizedMimeType === 'application/dash+xml' ||
    normalizedMimeType === 'application/vnd.apple.mpegurl' ||
    normalizedMimeType === 'application/x-mpegurl' ||
    normalizedMimeType === 'audio/mpegurl' ||
    normalizedMimeType === 'audio/x-mpegurl'
  ) {
    return true;
  }
  if (normalizedMimeType !== 'text/xml' && normalizedMimeType !== 'application/xml') return false;
  try {
    const parsedUrl = new URL(url);
    return /dash|manifest|interstitial/i.test(`${parsedUrl.hostname}${parsedUrl.pathname}`);
  } catch {
    return false;
  }
}

function attachPlaybackTraceEventListener(record: PlaybackTraceRecord): void {
  const listener = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId !== undefined) {
      handlePlaybackTraceDebuggerEvent(source.tabId, method, params);
    }
  };
  record.debuggerEventListener = listener;
  chrome.debugger.onEvent.addListener(listener);
}

function isTraceResourceType(type?: string): boolean {
  return type === 'Document' || type === 'Media' || type === 'XHR' || type === 'Fetch';
}

function isCaptionRetrievalResponse(
  response: unknown,
  candidateId: string,
): response is CaptionRetrievalResponse {
  return Boolean(
    response &&
      typeof response === 'object' &&
      'success' in response &&
      typeof response.success === 'boolean' &&
      'candidateId' in response &&
      response.candidateId === candidateId &&
      'warnings' in response &&
      Array.isArray(response.warnings) &&
      (response.success || ('failure' in response && response.failure)),
  );
}

async function captureCaptionSourcesWithDebugger(
  tabId: number,
  discovery: CaptionDiscoveryResponse,
): Promise<CdpCaptureResult> {
  if (playbackTrace?.state.phase === 'recording' && playbackTrace.state.tabId === tabId) {
    throw new Error('Stop Playback Trace before starting caption CDP monitoring on this tab.');
  }
  if (debuggerCapturesByTab.has(tabId))
    throw new Error('A caption capture is already active for this tab.');
  const debuggee = { tabId };
  const timeoutMs = 90_000;
  let pauseRequested = false;
  let pauseCapture = () => {
    pauseRequested = true;
  };
  debuggerCapturesByTab.add(tabId);
  debuggerCapturePausersByTab.set(tabId, () => pauseCapture());
  let attached = false;
  try {
    console.log('[Service Worker] CDP: attach begin', { tabId });
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    console.log('[Service Worker] CDP: attached', { tabId });
    await chrome.debugger.sendCommand(debuggee, 'Network.enable');
    console.log('[Service Worker] CDP: Network.enable complete', { tabId });
    return await new Promise((resolve) => {
      let settled = false;
      const pending = new Map<
        string,
        { url: string; contentType?: string; resourceType?: string }
      >();
      const captured: CapturedCaptionPayload[] = [];
      const bodyReads = new Set<Promise<void>>();
      const ignoredByReason: Record<string, number> = {};
      let responseCount = 0;
      let bodyReadCount = 0;
      let bodyReadFailures = 0;
      let acceptedCount = cdpCandidatesByTab.get(tabId)?.length || 0;
      const diagnostics = (): CaptionCaptureDiagnostics => ({
        responsesObserved: responseCount,
        bodiesRead: bodyReadCount,
        bodyReadFailures,
        candidatesAccepted: acceptedCount,
        ignoredByReason: { ...ignoredByReason },
      });
      const countIgnored = (reason: string) => {
        ignoredByReason[reason] = (ignoredByReason[reason] || 0) + 1;
      };
      const timeout = setTimeout(() => void finish(), timeoutMs);
      const finish = async (paused = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        chrome.debugger.onEvent.removeListener(onEvent);
        await Promise.allSettled([...bodyReads]);
        debuggerCapturePausersByTab.delete(tabId);
        console.log('[Service Worker] CDP: capture finished', {
          tabId,
          responseCount,
          bodyReadCount,
          bodyReadFailures,
        });
        resolve({
          payloads: captured,
          responseCount,
          bodyReadCount,
          bodyReadFailures,
          ignoredByReason: { ...ignoredByReason },
          paused,
        });
      };
      debuggerCapturePausersByTab.set(tabId, () => void finish(true));
      pauseCapture = () => void finish(true);
      const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
        if (source.tabId !== tabId || !params) return;
        if (method === 'Network.responseReceived') {
          const event = params as {
            requestId: string;
            type?: string;
            response: { url: string; mimeType?: string; headers?: Record<string, string> };
          };
          responseCount += 1;
          const contentType = event.response.mimeType || event.response.headers?.['content-type'];
          if (isWorthReadingCaptionResponse(event.response.url, contentType, event.type)) {
            pending.set(event.requestId, {
              url: event.response.url,
              contentType,
              resourceType: event.type,
            });
          } else {
            const reason =
              /^(?:font\/|image\/|audio\/|video\/|application\/(?:font-|x-font|zip|gzip|pdf|wasm))/i.test(
                contentType || '',
              )
                ? 'known-non-caption-mime'
                : 'unpromising-response';
            countIgnored(reason);
          }
        }
        if (method === 'Network.loadingFinished') {
          const requestId = (params as { requestId: string }).requestId;
          const request = pending.get(requestId);
          if (!request) return;
          pending.delete(requestId);
          const bodyRead = chrome.debugger
            .sendCommand(debuggee, 'Network.getResponseBody', { requestId })
            .then(async (body) => {
              bodyReadCount += 1;
              const responseBody = body as { body: string; base64Encoded?: boolean };
              const payload = responseBody.base64Encoded
                ? decodeBase64Utf8(responseBody.body)
                : responseBody.body;
              const format = validateCaptionPayload(request.url, request.contentType, payload);
              if (!format) {
                countIgnored('body-not-timed-caption');
                return;
              }
              const item: CapturedCaptionPayload = {
                payload,
                contentType: request.contentType,
                byteLength: new TextEncoder().encode(payload).byteLength,
                finalUrl: request.url,
              };
              if (!captured.some((existing) => existing.finalUrl === item.finalUrl)) {
                captured.push(item);
                acceptedCount += 1;
                await recordCapturedCdpCandidate(tabId, discovery, item, diagnostics());
              }
            })
            .catch(() => {
              bodyReadFailures += 1;
              countIgnored('response-body-unavailable');
            });
          bodyReads.add(bodyRead);
          void bodyRead.finally(() => bodyReads.delete(bodyRead));
        }
      };
      chrome.debugger.onEvent.addListener(onEvent);
      if (pauseRequested) {
        finish(true);
        return;
      }
      console.log('[Service Worker] CDP: reload begin', { tabId });
      chrome.tabs.reload(tabId, { bypassCache: true }).catch((error) => {
        if (!settled) {
          console.error('[Service Worker] CDP: reload failed', {
            tabId,
            error: formatError(error),
          });
          void finish();
        }
      });
    });
  } finally {
    debuggerCapturesByTab.delete(tabId);
    debuggerCapturePausersByTab.delete(tabId);
    if (attached) {
      await chrome.debugger.sendCommand(debuggee, 'Network.disable').catch((error) => {
        console.warn('[Service Worker] CDP: Network.disable failed', {
          tabId,
          error: formatError(error),
        });
      });
      await chrome.debugger.detach(debuggee).then(
        () => console.log('[Service Worker] CDP: detached', { tabId }),
        (error) =>
          console.warn('[Service Worker] CDP: detach failed', { tabId, error: formatError(error) }),
      );
    }
  }
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function redactCaptionUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:') {
      return `data:${url.pathname.split(';', 1)[0]};[payload omitted]`;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/token|signature|sig|auth|expires|exp|key/i.test(key))
        url.searchParams.set(key, '[redacted]');
    }
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

function cacheCaptionPayload(tabId: number, candidateId: string, payload: CapturedCaptionPayload) {
  let payloads = captionPayloadsByTab.get(tabId);
  if (!payloads) {
    payloads = new Map();
    captionPayloadsByTab.set(tabId, payloads);
  }
  payloads.set(candidateId, payload);
}

function cacheCaptionRetrieval(
  tabId: number,
  candidateId: string,
  result: CaptionRetrievalResponse,
) {
  let results = captionRetrievalsByTab.get(tabId);
  if (!results) {
    results = new Map();
    captionRetrievalsByTab.set(tabId, results);
  }
  results.set(candidateId, result);
}

function requestCaptionDiscovery(tabId: number): Promise<CaptionDiscoveryResponse | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'DISCOVER_CAPTION_SOURCES' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(undefined);
          return;
        }
        const discovery = response as CaptionDiscoveryResponse | undefined;
        if (!discovery || discovery.schemaVersion !== 1) {
          resolve(undefined);
          return;
        }
        resolve(discovery);
      });
    } catch {
      resolve(undefined);
    }
  });
}

function createCaptionFilename(
  candidate: { language?: string; label?: string },
  format: string,
): string {
  const base =
    (candidate.label || candidate.language || 'captions')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'captions';
  const extension = format === 'ttml' ? 'ttml2' : format === 'webvtt' ? 'vtt' : format;
  return `${base}.${extension === 'unknown' ? 'txt' : extension}`;
}

function classifyFetchFailure(
  error: unknown,
): 'network' | 'auth' | 'cors' | 'timeout' | 'size-limit' {
  const message = formatError(error).toLowerCase();
  if (message.includes('abort') || message.includes('timeout')) return 'timeout';
  if (message.includes('exceeds')) return 'size-limit';
  if (message.includes('401') || message.includes('403')) return 'auth';
  if (message.includes('cors')) return 'cors';
  return 'network';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function handleStartTabAudioCapture(
  tabId: number,
  sendResponse: (data: AudioCaptureResponse) => void,
) {
  try {
    await ensureOffscreenDocument();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    pendingTabCaptureStart = sendResponse;
    await chrome.runtime
      .sendMessage({
        target: 'offscreen',
        type: 'START_TAB_AUDIO_CAPTURE',
        streamId,
      })
      .catch((error) => {
        pendingTabCaptureStart?.({ success: false, error: formatTabCaptureError(error) });
        pendingTabCaptureStart = undefined;
      });
  } catch (error) {
    const formattedError = formatTabCaptureError(error);
    console.error('[Service Worker] Whole-tab capture failed:', formattedError);
    sendResponse({ success: false, error: formattedError });
  }
}

function handleOffscreenMessage(message: OffscreenMessage) {
  if (message.type === 'TAB_AUDIO_CAPTURE_STARTED') {
    pendingTabCaptureStart?.({ success: true, mimeType: message.mimeType });
    pendingTabCaptureStart = undefined;
  } else if (message.type === 'TAB_AUDIO_CAPTURE_ERROR') {
    pendingTabCaptureStart?.({ success: false, error: message.error });
    pendingTabCaptureStart = undefined;
    pendingTabCaptureStop?.({ success: false, error: message.error });
    pendingTabCaptureStop = undefined;
  } else if (message.type === 'TAB_AUDIO_CAPTURE_COMPLETE') {
    pendingTabCaptureStop?.({ success: true, data: message.data, mimeType: message.mimeType });
    pendingTabCaptureStop = undefined;
  }
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (
    contexts.some((context) => context.documentUrl?.endsWith('src/entries/offscreen/index.html'))
  ) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'src/entries/offscreen/index.html',
    reasons: ['USER_MEDIA'],
    justification: 'Record audio from the active tab when media element capture is unavailable',
  });
}

function formatTabCaptureError(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
