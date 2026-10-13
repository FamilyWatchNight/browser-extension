import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
