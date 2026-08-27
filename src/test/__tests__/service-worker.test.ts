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
    chromeFixture.messageListeners[0]({ type: 'VIDEO_STATE_UPDATE', videos }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ success: true });
    expect(chromeFixture.port.postMessage).toHaveBeenLastCalledWith({
      type: 'STATE_UPDATED',
      state: expect.objectContaining({ videos }),
    });
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
});
