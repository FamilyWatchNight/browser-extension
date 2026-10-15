import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackTraceEvent } from '../../shared/messages';
import { createChromeFixture } from '../fixtures/chrome';

describe('service-worker message contracts', () => {
  let chromeFixture: ReturnType<typeof createChromeFixture>;

  beforeEach(() => {
    vi.resetModules();
    chromeFixture = createChromeFixture();
    window.chrome = chromeFixture.chrome as unknown as typeof chrome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards video queries to the sender tab', async () => {
    const videos = [
      {
        id: 'video-1',
        src: 'video.mp4',
        title: 'Video',
        duration: 10,
        currentTime: 2,
        paused: true,
        frameIndex: 0,
      },
    ];
    chromeFixture.chrome.tabs.sendMessage = vi.fn((_tabId, _message, callback) => {
      callback(videos);
    });

    await import('../../entries/background/service-worker');

    const sendResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'GET_VIDEO_ELEMENTS' },
      {
        tab: { id: 42 },
        url: 'http://localhost',
      },
      sendResponse,
    );

    expect(chromeFixture.chrome.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      { type: 'GET_VIDEO_ELEMENTS' },
      expect.any(Function),
    );
    expect(sendResponse).toHaveBeenCalledWith(videos);
  });

  it('exports a per-tab analysis using bounded, redacted playback evidence', async () => {
    await import('../../entries/background/service-worker');

    const video = {
      id: 'private-element-id',
      src: 'https://private.example/movie?token=secret',
      title: 'Private title',
      duration: 3600,
      currentTime: 42,
      paused: false,
      frameIndex: 0,
      width: 1280,
      height: 720,
      isVisible: true,
      hasSource: true,
      readyState: 4,
      playbackRate: 1,
      seeking: false,
      buffering: false,
    };
    const updateResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'VIDEO_STATE_UPDATE', videos: [video] },
      { tab: { id: 42 } },
      updateResponse,
    );

    const exportResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'EXPORT_PLAYBACK_ANALYSIS', tabId: 42 },
      {},
      exportResponse,
    );

    expect(exportResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        report: expect.stringContaining('generic video behavior'),
      }),
    );
    const report = exportResponse.mock.calls[0][0].report as string;
    expect(report).toContain('0:42.0 / 1:00:00');
    expect(report).not.toContain('private-element-id');
    expect(report).not.toContain('Private title');
    expect(report).not.toContain('private.example');
    expect(report).not.toContain('secret');
  });

  it('captures and exports redacted metadata without reloading the tab', async () => {
    await import('../../entries/background/service-worker');

    const startResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'START_PLAYBACK_TRACE', tabId: 42 },
      {},
      startResponse,
    );
    await vi.waitFor(() =>
      expect(startResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          state: expect.objectContaining({ phase: 'recording', tabId: 42 }),
        }),
      ),
    );
    expect(chromeFixture.chrome.tabs.reload).not.toHaveBeenCalled();
    expect(chromeFixture.chrome.alarms.create).toHaveBeenCalledWith(
      expect.stringMatching(/^playbackTrace:/),
      expect.objectContaining({ when: expect.any(Number) }),
    );

    const onDebuggerEvent = chromeFixture.debuggerEventListeners[0];
    onDebuggerEvent({ tabId: 42 }, 'Network.requestWillBeSent', {
      requestId: 'request-1',
      type: 'Fetch',
      request: {
        method: 'GET',
        url: 'https://media.example/dash/7f1d9b61-4d25-4f17-a053-e710a76db19b/manifest.mpd?token=private',
      },
    });
    onDebuggerEvent({ tabId: 42 }, 'Network.responseReceived', {
      requestId: 'request-1',
      type: 'Fetch',
      response: {
        status: 200,
        mimeType: 'application/dash+xml',
        url: 'https://media.example/dash/7f1d9b61-4d25-4f17-a053-e710a76db19b/manifest.mpd?token=private',
      },
    });
    onDebuggerEvent({ tabId: 42 }, 'Network.loadingFinished', {
      requestId: 'request-1',
      encodedDataLength: 1024,
    });
    chromeFixture.messageListeners[0](
      {
        type: 'PLAYBACK_TRACE_CONTENT_EVENT',
        event: {
          name: 'page_click',
          timestamp: new Date().toISOString(),
          mediaTimes: [{ videoId: 'video-1', currentTime: 31.5 }],
          interaction: {
            type: 'click',
            isTrusted: true,
            targetTag: 'div',
            targetRole: 'slider',
            clientX: 220,
            clientY: 30,
            button: 0,
          },
        },
      },
      { tab: { id: 42 } },
      vi.fn(),
    );

    const stopResponse = vi.fn();
    chromeFixture.messageListeners[0]({ type: 'STOP_PLAYBACK_TRACE', tabId: 42 }, {}, stopResponse);
    await vi.waitFor(() =>
      expect(stopResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          state: expect.objectContaining({ phase: 'completed', endReason: 'manual' }),
        }),
      ),
    );

    const exportResponse = vi.fn();
    chromeFixture.messageListeners[0]({ type: 'EXPORT_PLAYBACK_TRACE' }, {}, exportResponse);
    await vi.waitFor(() => expect(exportResponse).toHaveBeenCalled());
    const exported = exportResponse.mock.calls[0][0];
    expect(exported.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'request',
          url: 'https://media.example/dash/<redacted>/manifest.mpd',
        }),
        expect.objectContaining({
          name: 'response',
          status: 200,
          mimeType: 'application/dash+xml',
        }),
        expect.objectContaining({
          category: 'interaction',
          name: 'page_click',
          mediaTimes: [{ videoId: 'video-1', currentTime: 31.5 }],
        }),
      ]),
    );
    expect(JSON.stringify(exported)).not.toContain('private');
    expect(Object.keys(chromeFixture.localStorage)).toContain('playbackTraceMeta');
  });

  it('returns the existing trace state when a new trace is rejected', async () => {
    await import('../../entries/background/service-worker');

    const startResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'START_PLAYBACK_TRACE', tabId: 42 },
      {},
      startResponse,
    );
    await vi.waitFor(() => expect(startResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        state: expect.objectContaining({ phase: 'recording', tabId: 42 }),
      }),
    ));

    const stopResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'STOP_PLAYBACK_TRACE', tabId: 42 },
      {},
      stopResponse,
    );
    await vi.waitFor(() =>
      expect(stopResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          state: expect.objectContaining({ phase: 'completed', tabId: 42 }),
        }),
      ),
    );

    const retryResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'START_PLAYBACK_TRACE', tabId: 1 },
      {},
      retryResponse,
    );
    await vi.waitFor(() =>
      expect(retryResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          state: expect.objectContaining({ phase: 'completed', tabId: 42 }),
          error: expect.stringContaining('A saved playback trace already exists'),
        }),
      ),
    );
  });

  it('captures only validated, sanitized manifest bodies within the trace', async () => {
    vi.spyOn(chromeFixture.chrome.debugger, 'sendCommand').mockImplementation(
      (_debuggee, method) =>
        method === 'Network.getResponseBody'
          ? Promise.resolve({
              body: '<MPD mediaPresentationDuration="PT90S"><BaseURL>https://cdn.example/ad?token=private</BaseURL><Period id="ad" duration="PT15S"/></MPD>',
              base64Encoded: false,
            })
          : Promise.resolve(undefined),
    );
    await import('../../entries/background/service-worker');

    const startResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'START_PLAYBACK_TRACE', tabId: 42 },
      {},
      startResponse,
    );
    await vi.waitFor(() => expect(startResponse).toHaveBeenCalled());

    const onDebuggerEvent = chromeFixture.debuggerEventListeners[0];
    onDebuggerEvent({ tabId: 42 }, 'Network.requestWillBeSent', {
      requestId: 'manifest-1',
      type: 'Fetch',
      request: {
        method: 'GET',
        url: 'https://ads.example/dash/interstitial/manifest.mpd?token=private',
      },
    });
    onDebuggerEvent({ tabId: 42 }, 'Network.responseReceived', {
      requestId: 'manifest-1',
      type: 'Fetch',
      response: {
        status: 200,
        mimeType: 'application/dash+xml',
        url: 'https://ads.example/dash/interstitial/manifest.mpd?token=private',
      },
    });
    onDebuggerEvent({ tabId: 42 }, 'Network.loadingFinished', {
      requestId: 'manifest-1',
      encodedDataLength: 200,
    });
    await vi.waitFor(() =>
      expect(chromeFixture.chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 42 },
        'Network.getResponseBody',
        { requestId: 'manifest-1' },
      ),
    );

    const stopResponse = vi.fn();
    chromeFixture.messageListeners[0]({ type: 'STOP_PLAYBACK_TRACE', tabId: 42 }, {}, stopResponse);
    await vi.waitFor(() =>
      expect(stopResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          state: expect.objectContaining({ phase: 'completed' }),
        }),
      ),
    );
    const exportResponse = vi.fn();
    chromeFixture.messageListeners[0]({ type: 'EXPORT_PLAYBACK_TRACE' }, {}, exportResponse);
    await vi.waitFor(() => expect(exportResponse).toHaveBeenCalled());

    const exported = exportResponse.mock.calls[0][0];
    expect(exported.state.bodyBytes).toBeGreaterThan(0);
    expect(exported.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'network',
          name: 'manifest_captured',
          manifestFormat: 'dash-mpd',
          manifestText: expect.stringContaining('mediaPresentationDuration="PT90S"'),
        }),
      ]),
    );
    expect(JSON.stringify(exported)).not.toContain('private');
    expect(JSON.stringify(exported)).not.toContain('https://cdn.example');
  });

  it('captures safe summaries for YouTube watch and ad-break JSON responses only', async () => {
    const responseBodies: Record<string, string> = {
      'watch-1': JSON.stringify({
        playerAds: { adBreaks: [{ startTime: 300, duration: 28, isSkippable: true }] },
        signedMediaUrl: 'https://media.example/video?signature=private',
      }),
      'ad-break-1': JSON.stringify({
        adBreaks: [{ startTime: 900, duration: 30, adType: 'midroll', adId: 'private-id' }],
      }),
    };
    let responseBodyIndex = 0;
    vi.spyOn(chromeFixture.chrome.debugger, 'sendCommand').mockImplementation(
      (_debuggee, method) =>
        method === 'Network.getResponseBody'
          ? Promise.resolve({
              body: Object.values(responseBodies)[responseBodyIndex++],
              base64Encoded: false,
            })
          : Promise.resolve(undefined),
    );
    await import('../../entries/background/service-worker');

    const startResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'START_PLAYBACK_TRACE', tabId: 42 },
      {},
      startResponse,
    );
    await vi.waitFor(() => expect(startResponse).toHaveBeenCalled());

    const onDebuggerEvent = chromeFixture.debuggerEventListeners[0];
    const responses = [
      {
        requestId: 'watch-1',
        path: '/youtubei/v1/get_watch',
      },
      {
        requestId: 'ad-break-1',
        path: '/youtubei/v1/player/ad_break',
      },
    ];
    for (const { requestId, path } of responses) {
      const url = `https://www.youtube.com${path}?token=private`;
      onDebuggerEvent({ tabId: 42 }, 'Network.requestWillBeSent', {
        requestId,
        type: 'Fetch',
        request: { method: 'POST', url },
      });
      onDebuggerEvent({ tabId: 42 }, 'Network.responseReceived', {
        requestId,
        type: 'Fetch',
        response: {
          status: 200,
          mimeType: 'application/json',
          url,
          headers: { 'content-length': '256' },
        },
      });
      onDebuggerEvent({ tabId: 42 }, 'Network.loadingFinished', {
        requestId,
        encodedDataLength: 256,
      });
    }

    const unrelatedResponse = 'https://www.youtube.com/youtubei/v1/player/other';
    onDebuggerEvent({ tabId: 42 }, 'Network.requestWillBeSent', {
      requestId: 'other-1',
      type: 'Fetch',
      request: { method: 'POST', url: unrelatedResponse },
    });
    onDebuggerEvent({ tabId: 42 }, 'Network.responseReceived', {
      requestId: 'other-1',
      type: 'Fetch',
      response: {
        status: 200,
        mimeType: 'application/json',
        url: unrelatedResponse,
      },
    });
    onDebuggerEvent({ tabId: 42 }, 'Network.loadingFinished', {
      requestId: 'other-1',
      encodedDataLength: 256,
    });

    const stopResponse = vi.fn();
    chromeFixture.messageListeners[0]({ type: 'STOP_PLAYBACK_TRACE', tabId: 42 }, {}, stopResponse);
    await vi.waitFor(() =>
      expect(stopResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          state: expect.objectContaining({ phase: 'completed' }),
        }),
      ),
    );
    const exportResponse = vi.fn();
    chromeFixture.messageListeners[0]({ type: 'EXPORT_PLAYBACK_TRACE' }, {}, exportResponse);
    await vi.waitFor(() => expect(exportResponse).toHaveBeenCalled());

    const exported = exportResponse.mock.calls[0][0];
    const summaries = exported.events.filter(
      (event: PlaybackTraceEvent) => event.name === 'youtube_ad_response_summary',
    );
    expect(summaries).toHaveLength(2);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: 'get_watch',
          responseSummary: expect.arrayContaining([
            { path: 'playerAds.adBreaks[0].startTime', value: 300 },
            { path: 'playerAds.adBreaks[0].duration', value: 28 },
          ]),
        }),
        expect.objectContaining({
          detail: 'ad_break',
          responseSummary: expect.arrayContaining([
            { path: 'adBreaks[0].startTime', value: 900 },
            { path: 'adBreaks[0].duration', value: 30 },
          ]),
        }),
      ]),
    );
    expect(JSON.stringify(exported)).not.toContain('private');
    expect(JSON.stringify(exported)).not.toContain('media.example');
    expect(
      vi
        .mocked(chromeFixture.chrome.debugger.sendCommand)
        .mock.calls.filter(([, method]) => method === 'Network.getResponseBody'),
    ).toHaveLength(2);
  });

  it('finalizes from the 150-minute alarm using the limit-ended status', async () => {
    await import('../../entries/background/service-worker');

    const startResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'START_PLAYBACK_TRACE', tabId: 42 },
      {},
      startResponse,
    );
    await vi.waitFor(() => expect(startResponse).toHaveBeenCalled());
    const traceId = startResponse.mock.calls[0][0].state.traceId;

    chromeFixture.alarmListeners[0]({ name: `playbackTrace:${traceId}` });

    await vi.waitFor(() => {
      expect(chromeFixture.localStorage.playbackTraceMeta).toEqual(
        expect.objectContaining({
          phase: 'limit-ended',
          endReason: 'duration-limit',
        }),
      );
    });

    expect(chromeFixture.chrome.alarms.clear).toHaveBeenCalledWith(`playbackTrace:${traceId}`);
  });

  it('stores video updates and broadcasts them to popup ports', async () => {
    await import('../../entries/background/service-worker');
    const videos = [
      {
        id: 'video-1',
        src: 'video.mp4',
        title: 'Video',
        duration: 10,
        currentTime: 2,
        paused: false,
        frameIndex: 0,
      },
    ];

    chromeFixture.connectListeners[0](chromeFixture.port);
    const sendResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'VIDEO_STATE_UPDATE', videos },
      { tab: { id: 42 } },
      sendResponse,
    );

    expect(sendResponse).toHaveBeenCalledWith({ success: true });
    expect(chromeFixture.port.postMessage).toHaveBeenLastCalledWith({
      type: 'STATE_UPDATED',
      state: expect.objectContaining({ videos }),
      tabId: 42,
    });
  });

  it('merges passive caption updates into the active tab state and persists them', async () => {
    await import('../../entries/background/service-worker');
    chromeFixture.connectListeners[0](chromeFixture.port);
    const candidate = {
      id: 'caption-source-live',
      videoId: 'video-1',
      kind: 'resource-url',
      format: 'unknown',
      url: 'https://captions.example/api/timedtext?lang=en',
      displayUrl: 'https://captions.example/api/timedtext',
      confidence: 'low',
      timing: 'unknown',
      evidence: [{ description: 'Resource timing entry matched timed-text URL heuristics' }],
    };

    chromeFixture.messageListeners[0](
      {
        type: 'CAPTION_DISCOVERY_UPDATE',
        discovery: {
          schemaVersion: 1,
          capturedAt: new Date().toISOString(),
          candidates: [candidate],
          limitations: [],
        },
      },
      { tab: { id: 42 } },
      vi.fn(),
    );

    await vi.waitFor(() =>
      expect(chromeFixture.port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CAPTION_STATE_UPDATED',
          state: expect.objectContaining({
            tabId: 42,
            phase: 'non-cdp-complete',
            discovery: expect.objectContaining({ candidates: [candidate] }),
          }),
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(chromeFixture.sessionStorage.captionCaptureStates).toEqual(
        expect.objectContaining({
          '42': expect.objectContaining({
            discovery: expect.objectContaining({ candidates: [candidate] }),
          }),
        }),
      ),
    );

    chromeFixture.messageListeners[0](
      {
        type: 'CAPTION_DISCOVERY_UPDATE',
        discovery: {
          schemaVersion: 1,
          capturedAt: new Date().toISOString(),
          candidates: [{ ...candidate, id: 'duplicate-caption-id' }],
          limitations: [],
        },
      },
      { tab: { id: 42 } },
      vi.fn(),
    );
    const persistedStates = chromeFixture.sessionStorage.captionCaptureStates as Record<
      string,
      { discovery?: { candidates: unknown[] } }
    >;
    await vi.waitFor(() =>
      expect(persistedStates['42']?.discovery?.candidates).toEqual([candidate]),
    );
  });

  it('sends current state on port requests and stops after disconnect', async () => {
    await import('../../entries/background/service-worker');
    chromeFixture.connectListeners[0](chromeFixture.port);
    const initialMessageCount = chromeFixture.port.postMessage.mock.calls.length;

    chromeFixture.portMessageListeners[0]({ type: 'REQUEST_STATE' });
    expect(chromeFixture.port.postMessage).toHaveBeenCalledTimes(initialMessageCount + 1);

    chromeFixture.portDisconnectListeners[0]();
    const sendResponse = vi.fn();
    chromeFixture.messageListeners[0](
      {
        type: 'VIDEO_STATE_UPDATE',
        videos: [],
      },
      {},
      sendResponse,
    );

    expect(chromeFixture.port.postMessage).toHaveBeenCalledTimes(initialMessageCount + 1);
  });

  it('keeps caption discovery non-CDP and persists retrieval state for popup restoration', async () => {
    const candidate = {
      id: 'caption-source-1',
      videoId: 'video-1',
      kind: 'resource-url',
      format: 'ttml',
      url: 'https://captions.example/subtitles.ttml',
      displayUrl: 'https://captions.example/subtitles.ttml',
      confidence: 'high',
      timing: 'exact',
      evidence: [{ description: 'Caption-like URL in page resources.' }],
    };
    const discovery = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      candidates: [candidate],
      limitations: [],
    };
    const retrieval = {
      success: true,
      candidateId: candidate.id,
      raw: {
        candidateId: candidate.id,
        format: 'ttml',
        filename: 'captions.ttml2',
        payload: '<tt><body>caption</body></tt>',
        byteLength: 29,
      },
      warnings: [],
    };
    chromeFixture.chrome.tabs.sendMessage = vi.fn((_tabId, message, callback) => {
      callback(message.type === 'DISCOVER_CAPTION_SOURCES' ? discovery : retrieval);
    });

    await import('../../entries/background/service-worker');
    chromeFixture.connectListeners[0](chromeFixture.port);

    const discoveryResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'DISCOVER_CAPTION_SOURCES', tabId: 42 },
      {},
      discoveryResponse,
    );
    await vi.waitFor(() =>
      expect(discoveryResponse).toHaveBeenCalledWith(
        expect.objectContaining({ schemaVersion: 1, candidates: [candidate] }),
      ),
    );
    expect(chromeFixture.chrome.tabs.reload).not.toHaveBeenCalled();
    expect(chromeFixture.port.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'CAPTION_STATE_UPDATED',
        state: expect.objectContaining({ tabId: 42, phase: 'non-cdp-complete' }),
      }),
    );

    const retrievalResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'RETRIEVE_CAPTION_SOURCE', tabId: 42, candidateId: candidate.id },
      {},
      retrievalResponse,
    );
    await vi.waitFor(() => expect(retrievalResponse).toHaveBeenCalledWith(retrieval));
    await vi.waitFor(() =>
      expect(chromeFixture.sessionStorage.captionCaptureStates).toEqual(
        expect.objectContaining({
          '42': expect.objectContaining({
            phase: 'non-cdp-complete',
            retrievals: { [candidate.id]: retrieval },
          }),
        }),
      ),
    );

    vi.resetModules();
    await import('../../entries/background/service-worker');
    chromeFixture.connectListeners[chromeFixture.connectListeners.length - 1]?.(chromeFixture.port);
    chromeFixture.portMessageListeners[chromeFixture.portMessageListeners.length - 1]?.({
      type: 'REQUEST_CAPTION_STATE',
      tabId: 42,
    });

    await vi.waitFor(() =>
      expect(chromeFixture.port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CAPTION_STATE_UPDATED',
          state: expect.objectContaining({
            tabId: 42,
            phase: 'non-cdp-complete',
            retrievals: { [candidate.id]: retrieval },
          }),
        }),
      ),
    );
  });

  it('preserves privacy-safe retrieval failure diagnostics in caption state', async () => {
    const candidate = {
      id: 'caption-source-failure',
      videoId: 'video-1',
      kind: 'resource-url',
      format: 'unknown',
      url: 'https://captions.example/subtitles?token=private',
      displayUrl: 'https://captions.example/subtitles',
      confidence: 'low',
      timing: 'unknown',
      evidence: [],
    };
    const discovery = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      candidates: [candidate],
      limitations: [],
    };
    const retrieval = {
      success: false,
      candidateId: candidate.id,
      warnings: [],
      failure: {
        category: 'network',
        message: 'Browser fetch failed before an HTTP response was available',
        diagnostics: {
          stage: 'request',
          endpoint: 'https://captions.example',
        },
      },
    };
    chromeFixture.chrome.tabs.sendMessage = vi.fn((_tabId, message, callback) => {
      callback(message.type === 'DISCOVER_CAPTION_SOURCES' ? discovery : retrieval);
    });

    await import('../../entries/background/service-worker');
    const discoveryResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'DISCOVER_CAPTION_SOURCES', tabId: 42 },
      {},
      discoveryResponse,
    );
    await vi.waitFor(() => expect(discoveryResponse).toHaveBeenCalled());

    const retrievalResponse = vi.fn();
    chromeFixture.messageListeners[0](
      {
        type: 'RETRIEVE_CAPTION_SOURCE',
        tabId: 42,
        candidateId: candidate.id,
      },
      {},
      retrievalResponse,
    );
    await vi.waitFor(() => expect(retrievalResponse).toHaveBeenCalledWith(retrieval));
    await vi.waitFor(() =>
      expect(chromeFixture.sessionStorage.captionCaptureStates).toEqual(
        expect.objectContaining({
          '42': expect.objectContaining({
            retrievals: { [candidate.id]: retrieval },
          }),
        }),
      ),
    );
    const persistedStates = chromeFixture.sessionStorage.captionCaptureStates as Record<
      string,
      { retrievals: Record<string, { failure?: { diagnostics?: unknown } }> }
    >;
    expect(
      JSON.stringify(persistedStates['42']?.retrievals[candidate.id]?.failure?.diagnostics),
    ).not.toContain('token=private');
  });

  it('persists a candidate-not-found failure instead of clearing it from popup state', async () => {
    const discovery = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      candidates: [],
      limitations: [],
    };
    chromeFixture.chrome.tabs.sendMessage = vi.fn((_tabId, _message, callback) => {
      callback(discovery);
    });

    await import('../../entries/background/service-worker');
    chromeFixture.connectListeners[0](chromeFixture.port);
    const response = vi.fn();
    chromeFixture.messageListeners[0](
      {
        type: 'RETRIEVE_CAPTION_SOURCE',
        tabId: 42,
        candidateId: 'candidate-no-longer-discovered',
      },
      {},
      response,
    );

    await vi.waitFor(() =>
      expect(response).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          candidateId: 'candidate-no-longer-discovered',
          failure: expect.objectContaining({
            category: 'inaccessible',
            message: 'Caption source was not discovered for this tab.',
          }),
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(chromeFixture.port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CAPTION_STATE_UPDATED',
          state: expect.objectContaining({
            tabId: 42,
            retrievals: {
              'candidate-no-longer-discovered': expect.objectContaining({
                success: false,
                failure: expect.objectContaining({
                  category: 'inaccessible',
                }),
              }),
            },
            retrievingCandidateIds: [],
          }),
        }),
      ),
    );
  });

  it('retains a newly discovered fetch URL when merging a URL-less candidate', async () => {
    const candidateWithoutUrl = {
      id: 'caption-source-existing',
      videoId: 'video-1',
      kind: 'resource-url',
      format: 'srt',
      displayUrl: 'https://captions.example/subtitles.srt?lang=en',
      confidence: 'low',
      timing: 'unknown',
      evidence: [{ description: 'Earlier resource observation' }],
    };
    const candidateWithUrl = {
      ...candidateWithoutUrl,
      id: 'caption-source-incremental',
      url: 'https://captions.example/subtitles.srt?lang=en',
      evidence: [{ description: 'Later resource observation' }],
    };
    const discovery = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      candidates: [candidateWithoutUrl],
      limitations: [],
    };
    const retrieval = {
      success: false,
      candidateId: candidateWithoutUrl.id,
      warnings: [],
      failure: {
        category: 'network',
        message: 'Browser fetch failed before an HTTP response was available',
        diagnostics: {
          stage: 'request',
          endpoint: 'https://captions.example',
        },
      },
    };
    chromeFixture.chrome.tabs.sendMessage = vi.fn((_tabId, message, callback) => {
      callback(message.type === 'DISCOVER_CAPTION_SOURCES' ? discovery : retrieval);
    });

    await import('../../entries/background/service-worker');
    chromeFixture.connectListeners[0](chromeFixture.port);
    const discoveryResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'DISCOVER_CAPTION_SOURCES', tabId: 42 },
      {},
      discoveryResponse,
    );
    await vi.waitFor(() => expect(discoveryResponse).toHaveBeenCalled());

    chromeFixture.messageListeners[0](
      {
        type: 'CAPTION_DISCOVERY_UPDATE',
        discovery: {
          schemaVersion: 1,
          capturedAt: new Date().toISOString(),
          candidates: [candidateWithUrl],
          limitations: [],
        },
      },
      { tab: { id: 42 } },
      vi.fn(),
    );

    await vi.waitFor(() =>
      expect(chromeFixture.port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CAPTION_STATE_UPDATED',
          state: expect.objectContaining({
            tabId: 42,
            discovery: expect.objectContaining({
              candidates: [
                expect.objectContaining({
                  id: candidateWithoutUrl.id,
                  url: candidateWithUrl.url,
                  evidence: [candidateWithoutUrl.evidence[0], candidateWithUrl.evidence[0]],
                }),
              ],
            }),
          }),
        }),
      ),
    );

    const retrievalResponse = vi.fn();
    chromeFixture.messageListeners[0](
      {
        type: 'RETRIEVE_CAPTION_SOURCE',
        tabId: 42,
        candidateId: candidateWithoutUrl.id,
      },
      {},
      retrievalResponse,
    );
    await vi.waitFor(() => expect(retrievalResponse).toHaveBeenCalledWith(retrieval));
    expect(chromeFixture.chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
      42,
      expect.objectContaining({
        type: 'RETRIEVE_CAPTION_SOURCE_IN_PAGE',
        candidate: expect.objectContaining({
          id: candidateWithoutUrl.id,
          url: candidateWithUrl.url,
        }),
      }),
      expect.any(Function),
    );
  });

  it('assigns distinct IDs to different candidates from incremental scans', async () => {
    const candidates = [
      {
        id: 'caption-source-1',
        videoId: 'video-1',
        kind: 'dom-sample',
        format: 'unknown',
        confidence: 'low',
        timing: 'sampled',
        evidence: [{ description: 'Caption-like DOM text surface found' }],
      },
      {
        id: 'caption-source-1',
        videoId: 'video-1',
        kind: 'resource-url',
        format: 'srt',
        url: 'https://captions.example/subtitles.srt?lang=en',
        displayUrl: 'https://captions.example/subtitles.srt?lang=en',
        confidence: 'low',
        timing: 'unknown',
        evidence: [{ description: 'Resource timing entry matched timed-text URL heuristics' }],
      },
    ];
    const discovery = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      candidates,
      limitations: [],
    };
    const retrieval = {
      success: false,
      candidateId: 'caption-source-1',
      warnings: [],
      failure: {
        category: 'network',
        message: 'Browser fetch failed before an HTTP response was available',
        diagnostics: {
          stage: 'request',
          endpoint: 'https://captions.example',
        },
      },
    };
    chromeFixture.chrome.tabs.sendMessage = vi.fn((_tabId, message, callback) => {
      if (message.type === 'DISCOVER_CAPTION_SOURCES') {
        callback(discovery);
      } else {
        const request = message as { candidate?: { id?: string } };
        callback({ ...retrieval, candidateId: request.candidate?.id });
      }
    });

    await import('../../entries/background/service-worker');
    chromeFixture.connectListeners[0](chromeFixture.port);
    const discoveryResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'DISCOVER_CAPTION_SOURCES', tabId: 42 },
      {},
      discoveryResponse,
    );

    let mergedCandidates: Array<{ id: string; kind: string; url?: string }> = [];
    await vi.waitFor(() => {
      const stateUpdate = chromeFixture.port.postMessage.mock.calls
        .map(([message]) => message)
        .find(
          (message) =>
            message.type === 'CAPTION_STATE_UPDATED' &&
            message.state.tabId === 42 &&
            message.state.discovery?.candidates?.length,
        );
      mergedCandidates = stateUpdate?.state.discovery?.candidates || [];
      expect(mergedCandidates).toHaveLength(2);
      expect(new Set(mergedCandidates.map(({ id }) => id)).size).toBe(2);
    });

    const resourceCandidate = mergedCandidates.find(({ kind }) => kind === 'resource-url');
    expect(resourceCandidate?.url).toBe(candidates[1].url);
    const retrievalResponse = vi.fn();
    chromeFixture.messageListeners[0](
      {
        type: 'RETRIEVE_CAPTION_SOURCE',
        tabId: 42,
        candidateId: resourceCandidate?.id,
      },
      {},
      retrievalResponse,
    );
    await vi.waitFor(() =>
      expect(retrievalResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateId: resourceCandidate?.id,
          failure: expect.objectContaining({ category: 'network' }),
        }),
      ),
    );
    expect(chromeFixture.chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
      42,
      expect.objectContaining({
        type: 'RETRIEVE_CAPTION_SOURCE_IN_PAGE',
        candidate: expect.objectContaining({
          kind: 'resource-url',
          url: candidates[1].url,
        }),
      }),
      expect.any(Function),
    );
  });

  it('does not use redacted display URLs as fetch URLs', async () => {
    const candidate = {
      id: 'caption-source-redacted-display-url',
      videoId: 'video-1',
      kind: 'resource-url',
      format: 'srt',
      displayUrl: 'https://captions.example/subtitles.srt?token=%5Bredacted%5D',
      confidence: 'low',
      timing: 'unknown',
      evidence: [],
    };
    const discovery = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      candidates: [candidate],
      limitations: [],
    };
    chromeFixture.chrome.tabs.sendMessage = vi.fn((_tabId, _message, callback) => {
      callback(discovery);
    });

    await import('../../entries/background/service-worker');
    const discoveryResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'DISCOVER_CAPTION_SOURCES', tabId: 42 },
      {},
      discoveryResponse,
    );
    await vi.waitFor(() => expect(discoveryResponse).toHaveBeenCalled());

    const retrievalResponse = vi.fn();
    chromeFixture.messageListeners[0](
      {
        type: 'RETRIEVE_CAPTION_SOURCE',
        tabId: 42,
        candidateId: candidate.id,
      },
      {},
      retrievalResponse,
    );

    await vi.waitFor(() =>
      expect(retrievalResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          failure: expect.objectContaining({
            category: 'inaccessible',
            message: 'Caption candidate does not expose a fetchable URL.',
          }),
        }),
      ),
    );
    expect(chromeFixture.chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('publishes validated CDP candidates while monitoring is still active', async () => {
    const discovery = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      candidates: [],
      limitations: [],
    };
    chromeFixture.chrome.tabs.sendMessage = vi.fn((_tabId, _message, callback) => {
      callback(discovery);
    });

    await import('../../entries/background/service-worker');
    chromeFixture.connectListeners[0](chromeFixture.port);

    const discoveryResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'DISCOVER_CAPTION_SOURCES', tabId: 42 },
      {},
      discoveryResponse,
    );
    await vi.waitFor(() => expect(discoveryResponse).toHaveBeenCalled());

    const startResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'SET_CAPTION_CDP_MONITORING', tabId: 42, action: 'start' },
      {},
      startResponse,
    );
    await vi.waitFor(() =>
      expect(startResponse).toHaveBeenCalledWith(expect.objectContaining({ success: true })),
    );
    await vi.waitFor(() => expect(chromeFixture.debuggerEventListeners).toHaveLength(1));

    const [onDebuggerEvent] = chromeFixture.debuggerEventListeners;
    onDebuggerEvent({ tabId: 42 }, 'Network.responseReceived', {
      requestId: 'caption-request',
      type: 'XHR',
      response: {
        url: 'data:application/json;base64,private-caption-payload',
        mimeType: 'text/plain',
      },
    });
    onDebuggerEvent({ tabId: 42 }, 'Network.loadingFinished', { requestId: 'caption-request' });

    await vi.waitFor(() =>
      expect(chromeFixture.port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CAPTION_STATE_UPDATED',
          state: expect.objectContaining({
            phase: 'cdp-monitoring',
            diagnostics: expect.objectContaining({
              responsesObserved: 1,
              bodiesRead: 1,
              candidatesAccepted: 1,
            }),
            discovery: expect.objectContaining({
              candidates: [
                expect.objectContaining({
                  format: 'srt',
                  confidence: 'high',
                  url: 'data:application/json;[payload omitted]',
                }),
              ],
            }),
          }),
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(JSON.stringify(chromeFixture.sessionStorage.captionCaptureStates)).not.toContain(
        'private-caption-payload',
      ),
    );

    const pauseResponse = vi.fn();
    chromeFixture.messageListeners[0](
      { type: 'SET_CAPTION_CDP_MONITORING', tabId: 42, action: 'pause' },
      {},
      pauseResponse,
    );
    await vi.waitFor(() =>
      expect(pauseResponse).toHaveBeenCalledWith(expect.objectContaining({ success: true })),
    );
  });
});
