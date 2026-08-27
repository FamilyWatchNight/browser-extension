import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChromeFixture } from '../fixtures/chrome';

describe('content-script lifecycle', () => {
  let chromeFixture: ReturnType<typeof createChromeFixture>;

  beforeEach(() => {
    vi.useFakeTimers();
    chromeFixture = createChromeFixture();
    window.chrome = chromeFixture.chrome as unknown as typeof chrome;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    document.body.innerHTML = '';
  });

  it('finds a video inserted after initialization', async () => {
    await import('../../entries/content-script/index');

    const video = document.createElement('video');
    video.src = 'late-video.mp4';
    document.body.appendChild(video);

    await vi.advanceTimersByTimeAsync(100);

    expect(chromeFixture.messageListeners).toHaveLength(1);
    const sendResponse = vi.fn();
    chromeFixture.messageListeners[0]({ type: 'GET_VIDEO_ELEMENTS' }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith([
      expect.objectContaining({
        src: 'http://localhost:3000/late-video.mp4',
        frameIndex: 0,
      }),
    ]);
  });

  it('removes a video after it leaves the document', async () => {
    const video = document.createElement('video');
    video.src = 'video.mp4';
    document.body.appendChild(video);

    await import('../../entries/content-script/index');
    video.remove();
    await vi.advanceTimersByTimeAsync(100);

    const sendResponse = vi.fn();
    chromeFixture.messageListeners[0]({ type: 'GET_VIDEO_ELEMENTS' }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith([]);
  });

  it('finds a video added to an accessible iframe after load', async () => {
    await import('../../entries/content-script/index');

    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const iframeDocument = iframe.contentDocument;
    expect(iframeDocument).not.toBeNull();

    iframeDocument!.body.innerHTML = '<video src="iframe-video.mp4"></video>';
    iframe.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(100);

    const sendResponse = vi.fn();
    chromeFixture.messageListeners[0]({ type: 'GET_VIDEO_ELEMENTS' }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith([
      expect.objectContaining({
        src: 'http://localhost:3000/iframe-video.mp4',
      }),
    ]);
  });

  it('registers the message listener before responding to an early query', async () => {
    await import('../../entries/content-script/index');

    expect(chromeFixture.messageListeners).toHaveLength(1);
    const sendResponse = vi.fn();
    const result = chromeFixture.messageListeners[0](
      { type: 'GET_VIDEO_ELEMENTS' },
      {},
      sendResponse,
    );

    expect(result).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith([]);
  });

  it('finds a video added inside an already-observed iframe', async () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);

    await import('../../entries/content-script/index');

    const iframeDocument = iframe.contentDocument;
    expect(iframeDocument).not.toBeNull();
    iframeDocument!.body.innerHTML = '<video src="nested-video.mp4"></video>';
    await vi.advanceTimersByTimeAsync(100);

    const sendResponse = vi.fn();
    chromeFixture.messageListeners[0]({ type: 'GET_VIDEO_ELEMENTS' }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith([
      expect.objectContaining({
        src: 'http://localhost:3000/nested-video.mp4',
      }),
    ]);
  });

  it('publishes current metadata after a media event', async () => {
    const video = document.createElement('video');
    Object.defineProperties(video, {
      duration: { configurable: true, value: 10 },
      currentTime: { configurable: true, value: 1 },
      paused: { configurable: true, value: true },
    });
    document.body.appendChild(video);

    await import('../../entries/content-script/index');

    Object.defineProperties(video, {
      duration: { configurable: true, value: 90 },
      currentTime: { configurable: true, value: 12 },
      paused: { configurable: true, value: false },
    });
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('timeupdate'));
    await vi.advanceTimersByTimeAsync(100);

    expect(chromeFixture.sendMessage).toHaveBeenCalledWith({
      type: 'VIDEO_STATE_UPDATE',
      videos: [
        expect.objectContaining({
          duration: 90,
          currentTime: 12,
          paused: false,
        }),
      ],
    });
  });
});
