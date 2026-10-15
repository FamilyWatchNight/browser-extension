import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CaptionCaptureState,
  CaptionDiscoveryResponse,
  CaptionRetrievalResponse,
  ContentPlayheadState,
  ExtensionState,
  PlaybackAnalysisExportResponse,
  PlaybackTraceResponse,
  PlaybackTraceState,
  VideoElement,
  ScreenshotBounds,
} from '../../shared/messages';
import { exportNormalizedWebVtt } from '../../shared/utils/caption-normalize';
import {
  formatPlaybackTime,
  getInterpolatedContentTime,
  updateContentPlayhead,
} from '../../shared/utils/content-playhead';
import { connectToServiceWorker } from '../../shared/utils/extension-api';
import { PLAYBACK_TRACE_MAX_DURATION_MS } from '../../shared/utils/playback-trace';
import { useExtensionStore } from '../../state/store';

export default function PopupApp() {
  const { isEnabled, setEnabled } = useExtensionStore();
  const [localVideos, setLocalVideos] = useState<VideoElement[]>([]);
  const [contentPlayhead, setContentPlayhead] = useState<ContentPlayheadState | undefined>(
    undefined,
  );
  const contentPlayheadRef = useRef<ContentPlayheadState | undefined>(undefined);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [selectedVideoId, setSelectedVideoId] = useState<string | undefined>();
  const [audioCaptureActive, setAudioCaptureActive] = useState(false);
  const [audioCaptureMode, setAudioCaptureMode] = useState<'video' | 'tab' | undefined>();
  const [audioCaptureError, setAudioCaptureError] = useState<string | undefined>();
  const [captionDiscovery, setCaptionDiscovery] = useState<CaptionDiscoveryResponse>();
  const [captionCaptureState, setCaptionCaptureState] = useState<CaptionCaptureState>();
  const [captionRetrievals, setCaptionRetrievals] = useState<
    Record<string, CaptionRetrievalResponse>
  >({});
  const [captionRetrievingIds, setCaptionRetrievingIds] = useState<string[]>([]);
  const [captionProbeError, setCaptionProbeError] = useState<string | undefined>();
  const [captionProbeLoading, setCaptionProbeLoading] = useState(false);
  const [captionRetrievingId, setCaptionRetrievingId] = useState<string | undefined>();
  const [captionRetrievalErrors, setCaptionRetrievalErrors] = useState<Record<string, string>>({});
  const [captionCdpActionLoading, setCaptionCdpActionLoading] = useState(false);
  const [playbackTraceState, setPlaybackTraceState] = useState<PlaybackTraceState>();
  const [playbackTraceBusy, setPlaybackTraceBusy] = useState(false);
  const [playbackTraceError, setPlaybackTraceError] = useState<string>();
  const [playbackAnalysisBusy, setPlaybackAnalysisBusy] = useState(false);
  const [playbackAnalysisError, setPlaybackAnalysisError] = useState<string>();
  const [, setPort] = useState<chrome.runtime.Port | null>(null);

  const updateVideos = useCallback((videos: VideoElement[]) => {
    const normalizedVideos = videos.map(normalizeVideo);
    setLocalVideos(normalizedVideos);
    const nextPlayhead = updateContentPlayhead(
      contentPlayheadRef.current,
      normalizedVideos,
      Date.now(),
    );
    contentPlayheadRef.current = nextPlayhead;
    setContentPlayhead(nextPlayhead);
    setSelectedVideoId((currentId) =>
      currentId && videos.some((video) => video.id === currentId) ? currentId : videos[0]?.id,
    );
  }, []);

  function normalizeVideo(video: VideoElement): VideoElement {
    return {
      ...video,
      width: Number.isFinite(video.width) ? video.width : 0,
      height: Number.isFinite(video.height) ? video.height : 0,
      isVisible: video.isVisible ?? false,
      hasSource: video.hasSource ?? Boolean(video.src),
      readyState: Number.isFinite(video.readyState) ? video.readyState : 0,
      playbackRate:
        video.playbackRate !== undefined &&
        Number.isFinite(video.playbackRate) &&
        video.playbackRate > 0
          ? video.playbackRate
          : 1,
      seeking: video.seeking ?? false,
      buffering: video.buffering ?? (!video.paused && video.readyState < 3),
    };
  }

  const fetchVideoElements = useCallback(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_ELEMENTS' });
        const videos = response || [];
        updateVideos(videos);
        if (videos.length > 0 || attempt === 3) return;
      } catch (e) {
        if (attempt === 3) {
          console.error('Failed to fetch videos:', e);
          return;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }, [updateVideos]);

  useEffect(() => {
    const newPort = connectToServiceWorker('popup-port');
    setPort(newPort);

    newPort.postMessage({ type: 'REQUEST_STATE' });
    let activeTabId: number | undefined;
    const handlePortMessage = (message: {
      type: string;
      state: ExtensionState | CaptionCaptureState | PlaybackTraceState;
      tabId?: number;
      contentPlayhead?: ContentPlayheadState;
    }) => {
      if (message.type === 'STATE_UPDATED') {
        if (message.tabId !== undefined && message.tabId === activeTabId) {
          updateVideos((message.state as ExtensionState).videos);
          if (message.contentPlayhead) {
            contentPlayheadRef.current = message.contentPlayhead;
            setContentPlayhead(message.contentPlayhead);
          }
        }
      } else if (
        message.type === 'CAPTION_STATE_UPDATED' &&
        activeTabId === (message.state as CaptionCaptureState).tabId
      ) {
        const state = message.state as CaptionCaptureState;
        setCaptionCaptureState(state);
        setCaptionDiscovery(state.discovery);
        setCaptionRetrievals(state.retrievals);
        setCaptionRetrievingIds(state.retrievingCandidateIds);
        setCaptionProbeLoading(state.phase === 'discovering');
        setCaptionProbeError(state.error);
      } else if (
        message.type === 'PLAYBACK_TRACE_UPDATED'
      ) {
        setPlaybackTraceState(message.state as PlaybackTraceState);
      }
    };
    newPort.onMessage.addListener(handlePortMessage);

    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab.id) return;
      activeTabId = tab.id;
      newPort.postMessage({ type: 'REQUEST_CAPTION_STATE', tabId: tab.id });
      newPort.postMessage({ type: 'REQUEST_PLAYBACK_TRACE_STATE', tabId: tab.id });
    });
    fetchVideoElements();

    return () => {
      newPort.onMessage.removeListener(handlePortMessage);
      newPort.disconnect();
    };
  }, [fetchVideoElements, updateVideos]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);

  async function runPlaybackTraceAction(action: 'start' | 'stop' | 'export' | 'delete') {
    setPlaybackTraceBusy(true);
    setPlaybackTraceError(undefined);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId =
        action === 'export' || action === 'delete'
          ? undefined
          : action === 'start'
            ? tab.id
            : (playbackTraceState?.tabId ?? tab.id);
      if (action !== 'export' && action !== 'delete' && tabId === undefined) {
        throw new Error('No active tab is available for playback tracing.');
      }
      const request =
        action === 'start'
          ? { type: 'START_PLAYBACK_TRACE', tabId }
          : action === 'stop'
            ? { type: 'STOP_PLAYBACK_TRACE', tabId }
            : action === 'export'
              ? { type: 'EXPORT_PLAYBACK_TRACE' }
              : { type: 'DELETE_PLAYBACK_TRACE' };
      const response = (await chrome.runtime.sendMessage(request)) as PlaybackTraceResponse;
      if (response?.state) setPlaybackTraceState(response.state);
      if (!response?.success)
        throw new Error(response?.error || 'Playback trace operation failed.');

      if (action === 'delete') {
        setPlaybackTraceState(undefined);
      }

      if (action === 'export' && response.state && response.events) {
        const artifact = JSON.stringify(
          { schemaVersion: 1, state: response.state, events: response.events },
          null,
          2,
        );
        const objectUrl = URL.createObjectURL(
          new Blob([artifact], { type: 'application/json;charset=utf-8' }),
        );
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = `playback-trace-${response.state.traceId}.json`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPlaybackTraceError(message);
    } finally {
      setPlaybackTraceBusy(false);
    }
  }

  async function exportPlaybackAnalysis() {
    setPlaybackAnalysisBusy(true);
    setPlaybackAnalysisError(undefined);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab.id === undefined) throw new Error('No active tab is available for analysis export.');
      const response = (await chrome.runtime.sendMessage({
        type: 'EXPORT_PLAYBACK_ANALYSIS',
        tabId: tab.id,
      })) as PlaybackAnalysisExportResponse;
      if (!response?.success || !response.report) {
        throw new Error(response?.error || 'Playback analysis export failed.');
      }

      const objectUrl = URL.createObjectURL(
        new Blob([response.report], { type: 'text/markdown;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `playback-analysis-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      setPlaybackAnalysisError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setPlaybackAnalysisBusy(false);
    }
  }

  async function controlVideo(action: 'play' | 'pause' | 'skip') {
    const selectedVideo = localVideos.find((video) => video.id === selectedVideoId);
    if (!selectedVideo) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    const videoId = selectedVideo.id;

    try {
      if (action === 'play') {
        await chrome.tabs.sendMessage(tab.id, { type: 'PLAY_VIDEO', videoId });
      } else if (action === 'pause') {
        await chrome.tabs.sendMessage(tab.id, { type: 'PAUSE_VIDEO', videoId });
      } else if (action === 'skip') {
        const currentTime = selectedVideo.currentTime + 10;
        await chrome.tabs.sendMessage(tab.id, {
          type: 'MOVE_PLAYHEAD',
          videoId,
          seekTime: currentTime,
        });
      }

      // Refresh video state
      await new Promise((r) => setTimeout(r, 500));
      fetchVideoElements();
    } catch (e) {
      console.error(`Failed to ${action} video:`, e);
    }
  }

  async function captureScreenshot() {
    const selectedVideo = localVideos.find((video) => video.id === selectedVideoId);
    if (!selectedVideo) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    const videoId = selectedVideo.id;

    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'CAPTURE_SCREENSHOT',
        videoId,
      });

      let screenshotData = response.success && response.data ? response.data : undefined;
      if (!screenshotData) {
        const visibleTabData = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: 'jpeg',
          quality: 90,
        });
        screenshotData = await cropTabCapture(visibleTabData, response.contentBounds);
      }
      const timestamp = new Date().toISOString().replace(/[.:]/g, '-');

      await chrome.downloads.download({
        url: screenshotData,
        filename: `screenshot-${timestamp}.jpg`,
        conflictAction: 'uniquify',
        saveAs: false,
      });
    } catch (e) {
      console.error('Failed to capture screenshot:', e);
    }
  }

  async function probeCaptions() {
    setCaptionProbeLoading(true);
    setCaptionProbeError(undefined);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) throw new Error('No active tab');
      let response: unknown;
      try {
        response = await chrome.runtime.sendMessage({
          type: 'DISCOVER_CAPTION_SOURCES',
          tabId: tab.id,
        });
      } catch {
        response = undefined;
      }
      if (!isCaptionDiscoveryResponse(response)) {
        response = await chrome.tabs.sendMessage(tab.id, { type: 'DISCOVER_CAPTION_SOURCES' });
      }
      if (!isCaptionDiscoveryResponse(response)) {
        throw new Error(`Invalid caption probe response: ${describeResponse(response)}`);
      }
      setCaptionDiscovery(response);
    } catch (error) {
      setCaptionProbeError(error instanceof Error ? error.message : String(error));
    } finally {
      setCaptionProbeLoading(false);
    }
  }

  async function setCdpMonitoring(action: 'start' | 'pause' | 'resume') {
    setCaptionCdpActionLoading(true);
    setCaptionProbeError(undefined);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) throw new Error('No active tab');
      const response = await chrome.runtime.sendMessage({
        type: 'SET_CAPTION_CDP_MONITORING',
        tabId: tab.id,
        action,
      });
      if (!response || response.success !== true) {
        throw new Error(response?.error || `Could not ${action} CDP monitoring`);
      }
      const state = response.state as CaptionCaptureState;
      setCaptionCaptureState(state);
      setCaptionDiscovery(state.discovery);
      setCaptionRetrievals(state.retrievals);
      setCaptionRetrievingIds(state.retrievingCandidateIds);
    } catch (error) {
      setCaptionProbeError(error instanceof Error ? error.message : String(error));
    } finally {
      setCaptionCdpActionLoading(false);
    }
  }

  function isCaptionDiscoveryResponse(response: unknown): response is CaptionDiscoveryResponse {
    return Boolean(
      response &&
      typeof response === 'object' &&
      'schemaVersion' in response &&
      response.schemaVersion === 1 &&
      'candidates' in response &&
      Array.isArray(response.candidates) &&
      'limitations' in response &&
      Array.isArray(response.limitations),
    );
  }

  function describeResponse(response: unknown): string {
    if (response === undefined) return 'no response from the extension or content script';
    if (response === null) return 'null response';
    if (typeof response !== 'object') return `${typeof response} response`;
    return `object with keys: ${Object.keys(response).join(', ') || '(none)'}`;
  }

  async function retrieveCaptions(candidateId: string) {
    setCaptionRetrievingId(candidateId);
    setCaptionRetrievalErrors((current) => ({ ...current, [candidateId]: '' }));
    setCaptionProbeError(undefined);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) throw new Error('No active tab');
      const candidate = captionDiscovery?.candidates.find((item) => item.id === candidateId);
      if (!candidate) throw new Error('Caption candidate is no longer available');
      const response: unknown = await chrome.runtime.sendMessage({
        type: 'RETRIEVE_CAPTION_SOURCE',
        tabId: tab.id,
        candidateId,
      });
      if (!isCaptionRetrievalResponse(response)) {
        throw new Error(`Invalid retrieval response: ${describeResponse(response)}`);
      }
      const retrievalResponse = response;
      setCaptionRetrievals((current) => ({ ...current, [candidateId]: retrievalResponse }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCaptionRetrievalErrors((current) => ({
        ...current,
        [candidateId]: message,
      }));
    } finally {
      setCaptionRetrievingId(undefined);
    }
  }

  function isCaptionRetrievalResponse(response: unknown): response is CaptionRetrievalResponse {
    if (
      !response ||
      typeof response !== 'object' ||
      !('success' in response) ||
      typeof response.success !== 'boolean' ||
      !('candidateId' in response) ||
      typeof response.candidateId !== 'string' ||
      !('warnings' in response) ||
      !Array.isArray(response.warnings)
    ) {
      return false;
    }
    if (response.success) return true;
    return Boolean(
      'failure' in response &&
        response.failure &&
        typeof response.failure === 'object' &&
        'category' in response.failure &&
        typeof response.failure.category === 'string' &&
        'message' in response.failure &&
        typeof response.failure.message === 'string',
    );
  }

  async function downloadCaptionArtifact(filename: string, payload: string, mimeType: string) {
    const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
    const safeFilename = filename.replace(/[^a-z0-9._-]+/gi, '-');
    await chrome.downloads.download({
      url: `data:${mimeType};charset=utf-8,${encodeURIComponent(payload)}`,
      filename: `captions-${timestamp}-${safeFilename}`,
      conflictAction: 'uniquify',
      saveAs: false,
    });
  }

  async function downloadRawCaptions(retrieval: CaptionRetrievalResponse) {
    if (!retrieval.raw) return;
    await downloadCaptionArtifact(
      `raw-${retrieval.raw.filename}`,
      retrieval.raw.payload,
      retrieval.raw.contentType || 'text/plain',
    );
  }

  async function downloadNormalizedCaptions(retrieval: CaptionRetrievalResponse) {
    if (!retrieval.normalized) return;
    await downloadCaptionArtifact(
      'normalized.json',
      JSON.stringify(retrieval.normalized, null, 2),
      'application/json',
    );
    await downloadCaptionArtifact(
      'normalized.vtt',
      exportNormalizedWebVtt(retrieval.normalized),
      'text/vtt',
    );
  }

  async function toggleAudioCapture() {
    const selectedVideo = localVideos.find((video) => video.id === selectedVideoId);
    if (!audioCaptureActive && !selectedVideo) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    try {
      if (!audioCaptureActive) {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'START_AUDIO_CAPTURE',
          videoId: selectedVideo!.id,
        });
        if (!response.success) {
          setAudioCaptureError(response.error || 'Unable to start audio capture');
          return;
        }
        setAudioCaptureError(undefined);
        setAudioCaptureActive(true);
        setAudioCaptureMode('video');
        return;
      }

      const response =
        audioCaptureMode === 'tab'
          ? await chrome.runtime.sendMessage({ type: 'STOP_TAB_AUDIO_CAPTURE' })
          : await chrome.tabs.sendMessage(tab.id, { type: 'STOP_AUDIO_CAPTURE' });
      setAudioCaptureActive(false);
      setAudioCaptureMode(undefined);
      if (!response?.success || !response.data) {
        setAudioCaptureError(response?.error || 'Unable to finish audio capture');
        return;
      }

      const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
      const extension = response.mimeType?.includes('ogg') ? 'ogg' : 'webm';
      await chrome.downloads.download({
        url: response.data,
        filename: `family-watch-night-audio-${timestamp}.${extension}`,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      setAudioCaptureError(undefined);
    } catch (error) {
      setAudioCaptureError(error instanceof Error ? error.message : String(error));
    }
  }

  async function captureWholeTabAudio() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'START_TAB_AUDIO_CAPTURE',
        tabId: tab.id,
      });
      if (!response?.success) {
        setAudioCaptureError(response?.error || 'Unable to start whole-tab capture');
        return;
      }
      setAudioCaptureError(undefined);
      setAudioCaptureActive(true);
      setAudioCaptureMode('tab');
    } catch (error) {
      setAudioCaptureError(error instanceof Error ? error.message : String(error));
    }
  }

  async function cropTabCapture(dataUrl: string, bounds?: ScreenshotBounds) {
    if (!bounds) return dataUrl;

    const image = new Image();
    image.src = dataUrl;
    await image.decode();

    const scaleX = image.naturalWidth / bounds.viewportWidth;
    const scaleY = image.naturalHeight / bounds.viewportHeight;
    const x = Math.max(0, Math.round(bounds.x * scaleX));
    const y = Math.max(0, Math.round(bounds.y * scaleY));
    const width = Math.min(image.naturalWidth - x, Math.round(bounds.width * scaleX));
    const height = Math.min(image.naturalHeight - y, Math.round(bounds.height * scaleY));
    if (width <= 0 || height <= 0) return dataUrl;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return dataUrl;

    context.drawImage(image, x, y, width, height, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.9);
  }

  const contentTime = getInterpolatedContentTime(contentPlayhead, clockNow);

  return (
    <div style={{ padding: '16px' }}>
      <h2 style={{ margin: '0 0 16px 0' }}>Virtual Remote Control</h2>

      <div style={{ marginBottom: '16px' }}>
        <label>
          <input
            type="checkbox"
            checked={isEnabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {' Enable'}
        </label>
      </div>

      <section
        aria-label="Playback Trace"
        style={{
          marginBottom: '16px',
          padding: '10px',
          border: '1px solid #d1d5db',
          borderRadius: '4px',
        }}
      >
        <strong>Playback Trace</strong>
        <div style={{ marginTop: '4px', fontSize: '12px', color: '#666' }}>
          Captures redacted network metadata, playback events, and validated DASH/HLS manifests
          (with resource URLs and DRM/license metadata removed) for up to{' '}
          {PLAYBACK_TRACE_MAX_DURATION_MS / 60_000} minutes. Start before a video appears.
        </div>
        {playbackTraceState?.phase === 'recording' ? (
          <>
            <div role="status" style={{ marginTop: '8px', fontSize: '12px' }}>
              Recording on tab {playbackTraceState.tabId}: {playbackTraceState.eventCount} events;{' '}
              {(playbackTraceState.serializedBytes / (1024 * 1024)).toFixed(2)} MiB;{' '}
              {(playbackTraceState.bodyBytes / 1024).toFixed(0)} KiB manifest text;{' '}
              {formatTraceElapsed(playbackTraceState.elapsedMs)} elapsed.
            </div>
            <div style={{ marginTop: '4px', fontSize: '12px', color: '#666' }}>
              Page clicks are recorded with coordinates and current video times. Seek events are
              correlated separately; a click is not assumed to have caused a seek.
            </div>
            {playbackTraceState.warning && (
              <div role="status" style={{ marginTop: '4px', color: '#92400e', fontSize: '12px' }}>
                {playbackTraceState.warning}
              </div>
            )}
            <button
              onClick={() => void runPlaybackTraceAction('stop')}
              disabled={playbackTraceBusy}
              style={{ marginTop: '8px', padding: '8px' }}
            >
              Stop trace
            </button>
          </>
        ) : playbackTraceState ? (
          <>
            <div role="status" style={{ marginTop: '8px', fontSize: '12px' }}>
              Trace {playbackTraceState.phase.replace('-', ' ')} after{' '}
              {formatTraceElapsed(playbackTraceState.elapsedMs)} with{' '}
              {playbackTraceState.eventCount} events (
              {(playbackTraceState.serializedBytes / (1024 * 1024)).toFixed(2)} MiB).
              {' '}{(playbackTraceState.bodyBytes / 1024).toFixed(0)} KiB manifest text.
              {playbackTraceState.endReason && ` End reason: ${playbackTraceState.endReason}.`}
            </div>
            {playbackTraceState.error && (
              <div role="alert" style={{ marginTop: '4px', color: '#b91c1c', fontSize: '12px' }}>
                {playbackTraceState.error}
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button
                onClick={() => void runPlaybackTraceAction('export')}
                disabled={playbackTraceBusy}
                style={{ padding: '8px' }}
              >
                Export trace
              </button>
              <button
                onClick={() => void runPlaybackTraceAction('delete')}
                disabled={playbackTraceBusy}
                style={{ padding: '8px' }}
              >
                Delete saved trace
              </button>
            </div>
          </>
        ) : (
          <button
            onClick={() => void runPlaybackTraceAction('start')}
            disabled={playbackTraceBusy}
            style={{ marginTop: '8px', padding: '8px' }}
          >
            {playbackTraceBusy ? 'Starting trace…' : 'Start Playback Trace'}
          </button>
        )}
        {playbackTraceError && (
          <div role="alert" style={{ marginTop: '6px', color: '#b91c1c', fontSize: '12px' }}>
            {playbackTraceError}
          </div>
        )}
      </section>

      <div style={{ marginBottom: '12px' }}>
        <button
          onClick={() => void exportPlaybackAnalysis()}
          disabled={playbackAnalysisBusy}
          style={{ padding: '6px 8px' }}
        >
          {playbackAnalysisBusy ? 'Preparing analysis…' : 'Export analysis'}
        </button>
        <span style={{ marginLeft: '6px', fontSize: '11px', color: '#666' }}>
          Local report; no titles, URLs, or network data.
        </span>
        {playbackAnalysisError && (
          <div role="alert" style={{ marginTop: '6px', color: '#b91c1c', fontSize: '12px' }}>
            {playbackAnalysisError}
          </div>
        )}
      </div>

      {localVideos.length > 0 ? (
        <>
          <div style={{ marginBottom: '12px', fontSize: '12px', color: '#666' }}>
            Found {localVideos.length} video(s)
          </div>

          {localVideos.length > 1 && (
            <div role="radiogroup" aria-label="Detected videos" style={{ marginBottom: '12px' }}>
              {localVideos.map((video, index) => {
                const isSelected = video.id === selectedVideoId;
                const sourceStatus = video.hasSource ? 'source' : 'no source';
                const playbackStatus = video.paused ? 'paused' : 'playing';

                return (
                  <button
                    key={video.id}
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => setSelectedVideoId(video.id)}
                    style={{
                      display: 'block',
                      width: '100%',
                      marginBottom: '6px',
                      padding: '8px',
                      textAlign: 'left',
                      border: isSelected ? '2px solid #2563eb' : '1px solid #ccc',
                      backgroundColor: isSelected ? '#eff6ff' : '#fff',
                      borderRadius: '4px',
                    }}
                  >
                    <strong>Video {index + 1}</strong>
                    <span style={{ display: 'block', fontSize: '11px', color: '#666' }}>
                      {Math.round(video.width)} x {Math.round(video.height)} px | {sourceStatus} |{' '}
                      {video.isVisible ? 'visible' : 'hidden'} | {playbackStatus}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {contentPlayhead && contentTime !== undefined && (
            <div
              role="timer"
              aria-label="Content playback position"
              style={{
                display: 'flex',
                justifyContent: 'flex-start',
                alignItems: 'center',
                marginBottom: '8px',
                fontVariantNumeric: 'tabular-nums',
                fontSize: '14px',
              }}
            >
              {formatPlaybackTime(contentTime, true)} /{' '}
              {formatPlaybackTime(contentPlayhead.duration, false)}
            </div>
          )}

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
            <button onClick={probeCaptions} style={{ padding: '8px' }}>
              {captionProbeLoading ? 'Finding captions...' : 'Find captions'}
            </button>
            <button onClick={toggleAudioCapture} style={{ padding: '8px' }}>
              {audioCaptureActive ? '⏹ Stop audio' : '🎙 Record audio'}
            </button>
          </div>

          {audioCaptureActive && (
            <div role="status" style={{ marginTop: '12px', fontSize: '12px' }}>
              {audioCaptureMode === 'tab'
                ? 'Recording all audio from this tab...'
                : 'Recording audio from the selected video...'}
            </div>
          )}
          {audioCaptureError && (
            <>
              <div role="alert" style={{ marginTop: '12px', fontSize: '12px', color: '#b91c1c' }}>
                {audioCaptureError}
              </div>
              {!audioCaptureActive && (
                <button onClick={captureWholeTabAudio} style={{ marginTop: '8px', padding: '8px' }}>
                  Record whole tab instead
                </button>
              )}
            </>
          )}

          {captionProbeError && (
            <div role="alert" style={{ marginTop: '12px', fontSize: '12px', color: '#b91c1c' }}>
              Caption probe failed: {captionProbeError}
            </div>
          )}

          {captionDiscovery && (
            <section style={{ marginTop: '12px', fontSize: '12px' }}>
              <strong>Likely caption sources ({captionDiscovery.candidates.length})</strong>
              <div style={{ marginTop: '4px', color: '#666' }}>
                Try these sources first. CDP monitoring is a separate step and reloads the tab.
              </div>
              {captionCaptureState && (
                <div role="status" style={{ marginTop: '6px' }}>
                  {captionCaptureState.phase === 'discovering' &&
                    'Finding likely caption sources without CDP…'}
                  {captionCaptureState.phase === 'non-cdp-complete' &&
                    (captionDiscovery.candidates.length
                      ? 'Discovery finished. Try retrieving a likely source, or start CDP monitoring if none works.'
                      : 'No likely source found without CDP. Start CDP monitoring to inspect network responses; this reloads the tab.')}
                  {captionCaptureState.phase === 'cdp-monitoring' &&
                    'CDP is actively monitoring network responses after reload. Keep playback going.'}
                  {captionCaptureState.phase === 'cdp-paused' && 'CDP monitoring is paused.'}
                  {captionCaptureState.phase === 'complete' &&
                    'A caption response was captured. Retrieve a likely source below.'}
                  {captionCaptureState.phase === 'no-match' &&
                    'CDP monitoring finished without finding a usable caption response.'}
                  {captionCaptureState.phase === 'failed' && 'Caption discovery or capture failed.'}
                </div>
              )}
              {captionCaptureState?.diagnostics.responsesObserved ? (
                <div style={{ marginTop: '6px', padding: '6px', backgroundColor: '#f7f7f7' }}>
                  <strong>Traffic summary:</strong>{' '}
                  {captionCaptureState.diagnostics.responsesObserved} responses inspected;{' '}
                  {captionCaptureState.diagnostics.bodiesRead} bodies checked;{' '}
                  {captionCaptureState.diagnostics.candidatesAccepted} timed-text candidate(s)
                  accepted.
                  {Object.keys(captionCaptureState.diagnostics.ignoredByReason).length > 0 && (
                    <div>
                      Ignored:{' '}
                      {Object.entries(captionCaptureState.diagnostics.ignoredByReason)
                        .map(([reason, count]) => `${formatIgnoredReason(reason)} (${count})`)
                        .join(', ')}
                    </div>
                  )}
                  {captionCaptureState.diagnostics.bodyReadFailures > 0 && (
                    <div>
                      {captionCaptureState.diagnostics.bodyReadFailures} response body read(s)
                      failed.
                    </div>
                  )}
                </div>
              ) : null}
              {captionDiscovery.candidates.map((candidate) => {
                const retrieval = captionRetrievals[candidate.id];
                const isRetrieving =
                  captionRetrievingId === candidate.id ||
                  captionRetrievingIds.includes(candidate.id);
                return (
                  <div
                    key={candidate.id}
                    style={{ marginTop: '8px', padding: '8px', backgroundColor: '#f0f0f0' }}
                  >
                    <strong>
                      {candidate.kind} / {candidate.format} /{' '}
                      {candidate.language || 'language unknown'}
                    </strong>
                    <div>
                      {candidate.confidence} confidence; {candidate.timing} timing
                    </div>
                    {candidate.displayUrl && <div>Source: {candidate.displayUrl}</div>}
                    {candidate.evidence.map((item, index) => (
                      <div key={`${candidate.id}-evidence-${index}`}>- {item.description}</div>
                    ))}
                    <div role={retrieval?.success ? 'status' : undefined}>
                      {isRetrieving
                        ? 'Retrieving captions…'
                        : retrieval?.success
                          ? 'Captions retrieved successfully.'
                          : retrieval?.failure
                            ? `Retrieval failed: ${retrieval.failure.category}`
                            : 'Not retrieved yet.'}
                    </div>
                    {(candidate.limitations || []).map((limitation) => (
                      <div key={limitation} style={{ color: '#666' }}>
                        Note: {limitation}
                      </div>
                    ))}
                    <button
                      onClick={() => retrieveCaptions(candidate.id)}
                      disabled={
                        (candidate.kind !== 'native-track' && !candidate.url) || isRetrieving
                      }
                      style={{ marginTop: '6px', padding: '4px 8px' }}
                    >
                      {isRetrieving
                        ? 'Retrieving...'
                        : candidate.kind === 'native-track'
                          ? 'Retrieve captions'
                          : 'Fetch captions'}
                    </button>
                    {retrieval?.raw && (
                      <button
                        onClick={() => downloadRawCaptions(retrieval)}
                        style={{ margin: '6px 0 0 6px', padding: '4px 8px' }}
                      >
                        Download raw ({retrieval.raw.format})
                      </button>
                    )}
                    {retrieval?.normalized && (
                      <button
                        onClick={() => downloadNormalizedCaptions(retrieval)}
                        style={{ margin: '6px 0 0 6px', padding: '4px 8px' }}
                      >
                        Download normalized (JSON + WebVTT)
                      </button>
                    )}
                    {retrieval?.failure && (
                      <div role="alert" style={{ color: '#b91c1c' }}>
                        {retrieval.failure.category}: {retrieval.failure.message}
                        {retrieval.failure.diagnostics && (
                          <div style={{ color: '#7f1d1d', marginTop: '4px' }}>
                            <div>
                              Stage: {retrieval.failure.diagnostics.stage.replace(/-/g, ' ')}
                            </div>
                            {retrieval.failure.diagnostics.endpoint && (
                              <div>
                                Endpoint: {retrieval.failure.diagnostics.endpoint} (query and path
                                omitted)
                              </div>
                            )}
                            {retrieval.failure.diagnostics.stage === 'request' && (
                              <div>Request: GET with browser credentials included</div>
                            )}
                            {retrieval.failure.diagnostics.httpStatus !== undefined && (
                              <div>HTTP status: {retrieval.failure.diagnostics.httpStatus}</div>
                            )}
                            {retrieval.failure.diagnostics.contentType && (
                              <div>Response type: {retrieval.failure.diagnostics.contentType}</div>
                            )}
                            {retrieval.failure.diagnostics.responseBytes !== undefined && (
                              <div>
                                Response size: {retrieval.failure.diagnostics.responseBytes} bytes
                              </div>
                            )}
                            {retrieval.failure.diagnostics.stage === 'request' && (
                              <div>
                                No HTTP response was exposed to the extension; the browser does not
                                identify whether this was CORS, DNS, TLS, or another network
                                failure.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {captionRetrievalErrors[candidate.id] && (
                      <div role="alert" style={{ color: '#b91c1c' }}>
                        Retrieval failed: {captionRetrievalErrors[candidate.id]}
                      </div>
                    )}
                    {retrieval?.warnings.map((warning) => (
                      <div key={`${candidate.id}-${warning.code}`} style={{ color: '#666' }}>
                        Warning: {warning.message}
                      </div>
                    ))}
                  </div>
                );
              })}
              {captionDiscovery.candidates.length === 0 && <div>No caption sources found.</div>}
              {captionCaptureState?.phase === 'cdp-monitoring' ? (
                <button
                  onClick={() => setCdpMonitoring('pause')}
                  disabled={captionCdpActionLoading}
                  style={{ marginTop: '8px', padding: '6px 8px' }}
                >
                  {captionCdpActionLoading ? 'Pausing…' : 'Pause CDP monitoring'}
                </button>
              ) : captionCaptureState?.phase === 'cdp-paused' ? (
                <button
                  onClick={() => setCdpMonitoring('resume')}
                  disabled={captionCdpActionLoading}
                  style={{ marginTop: '8px', padding: '6px 8px' }}
                >
                  {captionCdpActionLoading ? 'Resuming…' : 'Resume CDP monitoring (reload)'}
                </button>
              ) : ['non-cdp-complete', 'no-match', 'failed'].includes(
                  captionCaptureState?.phase || '',
                ) ? (
                <button
                  onClick={() => setCdpMonitoring('start')}
                  disabled={captionCdpActionLoading}
                  style={{ marginTop: '8px', padding: '6px 8px' }}
                >
                  {captionCdpActionLoading ? 'Starting…' : 'Start CDP monitoring (reload)'}
                </button>
              ) : null}
              {captionDiscovery.limitations.map((limitation) => (
                <div key={limitation} style={{ marginTop: '4px', color: '#666' }}>
                  Note: {limitation}
                </div>
              ))}
            </section>
          )}

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
  );
}

function formatIgnoredReason(reason: string): string {
  switch (reason) {
    case 'known-non-caption-mime':
      return 'known binary/media type';
    case 'unpromising-response':
      return 'not a likely text response';
    case 'body-not-timed-caption':
      return 'body lacked a valid timed-caption signature';
    case 'response-body-unavailable':
      return 'response body unavailable';
    default:
      return reason;
  }
}

function formatTraceElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}
