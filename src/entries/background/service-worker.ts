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

type PersistedCaptionCaptureState = CaptionCaptureState & {
  cdpCandidates: CaptionSourceCandidate[];
  payloads: Record<string, CapturedCaptionPayload>;
};

let captionPersistenceQueue = Promise.resolve();
const captionStateReady = restoreCaptionStates().catch((error) => {
  console.error('[Service Worker] Failed to restore caption state:', formatError(error));
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
      case 'SET_CAPTION_CDP_MONITORING':
        handleSetCaptionCdpMonitoring(message.tabId, message.action, sendResponse);
        return true;
      case 'RETRIEVE_CAPTION_SOURCE':
        handleRetrieveCaptionSource(message.tabId, message.candidateId, sendResponse);
        return true;
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
        broadcastState();
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

function broadcastState() {
  const state = useExtensionStore.getState();
  popupPorts.forEach((port) => port.postMessage({ type: 'STATE_UPDATED', state }));
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
    const merged: CaptionDiscoveryResponse = {
      ...discovery,
      capturedAt: new Date().toISOString(),
      candidates: mergeCaptionCandidates(
        tabId,
        discovery.candidates,
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
        evidence: [...existing.evidence, ...candidate.evidence],
      };
    }
  });
  return merged;
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
  try {
    let discovery = captionCandidatesByTab.get(tabId);
    if (!discovery) discovery = await requestCaptionDiscovery(tabId);
    const candidate = discovery?.candidates.find(({ id }) => id === candidateId);
    if (!candidate) {
      sendResponse({
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
    const cachedResult = captionRetrievalsByTab.get(tabId)?.get(candidateId);
    if (cachedResult?.success) {
      sendResponse(cachedResult);
      return;
    }
    if (!candidate.url && candidate.kind !== 'native-track') {
      sendResponse({
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
            resolve(response as CaptionRetrievalResponse);
          },
        );
      });
      cacheCaptionRetrieval(tabId, candidateId, result);
      sendResponse(result);
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
      cacheCaptionRetrieval(tabId, candidateId, result);
      sendResponse(result);
    } catch (error) {
      const result = {
        success: false,
        candidateId,
        raw,
        warnings: [],
        failure: { category: 'unsupported-format', message: formatError(error) },
      } as CaptionRetrievalResponse;
      cacheCaptionRetrieval(tabId, candidateId, result);
      sendResponse(result);
    }
  } catch (error) {
    const result: CaptionRetrievalResponse = {
      success: false,
      candidateId,
      warnings: [],
      failure: { category: classifyFetchFailure(error), message: formatError(error) },
    };
    cacheCaptionRetrieval(tabId, candidateId, result);
    sendResponse(result);
  } finally {
    retrieving.delete(candidateId);
    if (retrieving.size === 0) retrievingCandidateIdsByTab.delete(tabId);
    const state = getCaptionState(tabId);
    await updateCaptionState(tabId, state.phase, state.discovery);
  }
}

async function captureCaptionSourcesWithDebugger(
  tabId: number,
  discovery: CaptionDiscoveryResponse,
): Promise<CdpCaptureResult> {
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
        captionCandidatesByTab.set(tabId, discovery);
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
