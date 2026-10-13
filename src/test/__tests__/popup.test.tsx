import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PopupApp from '../../entries/popup/App';
import { createChromeFixture } from '../fixtures/chrome';

describe('popup video discovery', () => {
  let chromeFixture: ReturnType<typeof createChromeFixture>;

  beforeEach(() => {
    vi.useFakeTimers();
    chromeFixture = createChromeFixture();
    window.chrome = chromeFixture.chrome as unknown as typeof chrome;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries when the page initially has no videos', async () => {
    const video = {
      id: 'video-1',
      src: 'video.mp4',
      title: 'Video',
      duration: 10,
      currentTime: 0,
      paused: true,
      frameIndex: 0,
    };
    chromeFixture.chrome.tabs.sendMessage = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([video]);

    render(<PopupApp />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(chromeFixture.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Found 1 video(s)')).toBeTruthy();
  });

  it('does not replace active-tab videos with unscoped or other-tab state', async () => {
    const video = {
      id: 'video-1',
      src: 'video.mp4',
      title: 'Video',
      duration: 10,
      currentTime: 0,
      paused: true,
      frameIndex: 0,
    };
    chromeFixture.chrome.tabs.sendMessage = vi.fn().mockResolvedValue([video]);

    render(<PopupApp />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Found 1 video(s)')).toBeTruthy();

    await act(async () => {
      chromeFixture.portMessageListeners[0]({
        type: 'STATE_UPDATED',
        state: { isEnabled: true, videos: [], playbackState: {}, settings: { isEnabled: true } },
      });
      chromeFixture.portMessageListeners[0]({
        type: 'STATE_UPDATED',
        tabId: 2,
        state: { isEnabled: true, videos: [], playbackState: {}, settings: { isEnabled: true } },
      });
      await Promise.resolve();
    });

    expect(screen.getByText('Found 1 video(s)')).toBeTruthy();
  });

  it('retries after a message failure', async () => {
    const video = {
      id: 'video-1',
      src: 'video.mp4',
      title: 'Video',
      duration: 10,
      currentTime: 0,
      paused: true,
      frameIndex: 0,
    };
    chromeFixture.chrome.tabs.sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('Content script is not ready'))
      .mockResolvedValueOnce([video]);

    render(<PopupApp />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(chromeFixture.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Found 1 video(s)')).toBeTruthy();
  });

  it('stops after four empty responses', async () => {
    chromeFixture.chrome.tabs.sendMessage = vi.fn().mockResolvedValue([]);

    render(<PopupApp />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(750);
    });

    expect(chromeFixture.chrome.tabs.sendMessage).toHaveBeenCalledTimes(4);
    expect(
      screen.getByText('No video found on this page. Try navigating to a video streaming site.'),
    ).toBeTruthy();
  });

  it('downloads a captured screenshot in the Downloads folder', async () => {
    const video = {
      id: 'video-1',
      src: 'video.mp4',
      title: 'Video',
      duration: 10,
      currentTime: 0,
      paused: true,
      frameIndex: 0,
    };
    chromeFixture.chrome.tabs.sendMessage = vi
      .fn()
      .mockResolvedValueOnce([video])
      .mockResolvedValueOnce({ success: true, data: 'data:image/jpeg;base64,captured-image' });

    render(<PopupApp />);

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: /Screenshot/ }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(chromeFixture.chrome.downloads.download).toHaveBeenCalledWith({
      url: 'data:image/jpeg;base64,captured-image',
      filename: expect.stringMatching(/^screenshot-.*\.jpg$/),
      conflictAction: 'uniquify',
      saveAs: false,
    });
  });

  it('falls back to a visible tab capture when canvas capture is blank', async () => {
    const video = {
      id: 'video-1',
      src: 'video.mp4',
      title: 'Video',
      duration: 10,
      currentTime: 0,
      paused: true,
      frameIndex: 0,
    };
    chromeFixture.chrome.tabs.sendMessage = vi
      .fn()
      .mockResolvedValueOnce([video])
      .mockResolvedValueOnce({
        success: false,
        error: 'Canvas capture returned a blank image',
        contentBounds: {
          x: 200,
          y: 0,
          width: 1200,
          height: 900,
          viewportWidth: 1600,
          viewportHeight: 900,
        },
      });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/jpeg;base64,cropped-tab',
    );
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 1600;
        naturalHeight = 900;
        src = '';

        decode() {
          return Promise.resolve();
        }
      },
    );

    render(<PopupApp />);

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: /Screenshot/ }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(chromeFixture.chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(1, {
      format: 'jpeg',
      quality: 90,
    });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 200, 0, 1200, 900, 0, 0, 1200, 900);
    expect(chromeFixture.chrome.downloads.download).toHaveBeenCalledWith({
      url: 'data:image/jpeg;base64,cropped-tab',
      filename: expect.stringMatching(/^screenshot-.*\.jpg$/),
      conflictAction: 'uniquify',
      saveAs: false,
    });
  });

  it('controls the explicitly selected video', async () => {
    const firstVideo = {
      id: 'video-1',
      src: 'small.mp4',
      title: 'Small',
      duration: 10,
      currentTime: 3,
      paused: true,
      frameIndex: 0,
      width: 320,
      height: 180,
      isVisible: true,
      hasSource: true,
      readyState: 4,
    };
    const secondVideo = {
      ...firstVideo,
      id: 'video-2',
      src: 'movie.mp4',
      title: 'Movie',
      currentTime: 27,
      width: 1280,
      height: 720,
    };
    chromeFixture.chrome.tabs.sendMessage = vi
      .fn()
      .mockResolvedValueOnce([firstVideo, secondVideo]);

    render(<PopupApp />);

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('radio', { name: /Video 2/ }));
    fireEvent.click(screen.getByRole('button', { name: /Skip/ }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(chromeFixture.chrome.tabs.sendMessage).toHaveBeenCalledWith(1, {
      type: 'MOVE_PLAYHEAD',
      videoId: 'video-2',
      seekTime: 37,
    });
  });

  it('updates the visible caption phase and candidate result from background state', async () => {
    chromeFixture.chrome.tabs.sendMessage = vi.fn().mockResolvedValue([
      {
        id: 'video-1',
        src: 'video.mp4',
        title: 'Video',
        duration: 10,
        currentTime: 0,
        paused: true,
        frameIndex: 0,
      },
    ]);
    render(<PopupApp />);
    await vi.waitFor(() =>
      expect(chromeFixture.port.postMessage).toHaveBeenCalledWith({
        type: 'REQUEST_CAPTION_STATE',
        tabId: 1,
      }),
    );
    const candidate = {
      id: 'caption-source-1',
      videoId: 'video-1',
      kind: 'resource-url' as const,
      format: 'ttml' as const,
      url: 'https://captions.example/subtitles.ttml',
      displayUrl: 'https://captions.example/subtitles.ttml',
      confidence: 'high' as const,
      timing: 'exact' as const,
      evidence: [{ description: 'Caption-like URL in page resources.' }],
    };
    const retrieval = {
      success: true,
      candidateId: candidate.id,
      raw: {
        candidateId: candidate.id,
        format: 'ttml' as const,
        filename: 'captions.ttml2',
        payload: '<tt><body>caption</body></tt>',
        byteLength: 29,
      },
      warnings: [],
    };

    await act(async () => {
      chromeFixture.portMessageListeners[0]({
        type: 'CAPTION_STATE_UPDATED',
        state: {
          tabId: 1,
          phase: 'cdp-monitoring',
          discovery: {
            schemaVersion: 1,
            capturedAt: new Date().toISOString(),
            candidates: [candidate],
            limitations: [],
          },
          retrievals: { [candidate.id]: retrieval },
          retrievingCandidateIds: [],
          diagnostics: {
            responsesObserved: 7,
            bodiesRead: 2,
            bodyReadFailures: 1,
            candidatesAccepted: 1,
            ignoredByReason: { 'known-non-caption-mime': 4 },
          },
          updatedAt: new Date().toISOString(),
        },
      });
      await Promise.resolve();
    });

    expect(
      screen.getByText(
        'CDP is actively monitoring network responses after reload. Keep playback going.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Captions retrieved successfully.')).toBeTruthy();
    expect(screen.getByText('Traffic summary:').parentElement?.textContent).toContain(
      '7 responses inspected; 2 bodies checked; 1 timed-text candidate(s) accepted.',
    );
    expect(screen.getByText('Ignored: known binary/media type (4)')).toBeTruthy();
    expect(screen.getByText('1 response body read(s) failed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause CDP monitoring' })).toBeTruthy();
  });

  it('shows privacy-safe retrieval failure diagnostics', async () => {
    chromeFixture.chrome.tabs.sendMessage = vi.fn().mockResolvedValue([
      {
        id: 'video-1',
        src: 'video.mp4',
        title: 'Video',
        duration: 10,
        currentTime: 0,
        paused: true,
        frameIndex: 0,
      },
    ]);
    render(<PopupApp />);
    await act(async () => {
      await vi.waitFor(() =>
        expect(chromeFixture.port.postMessage).toHaveBeenCalledWith({
          type: 'REQUEST_CAPTION_STATE',
          tabId: 1,
        }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      chromeFixture.portMessageListeners[0]({
        type: 'CAPTION_STATE_UPDATED',
        state: {
          tabId: 1,
          phase: 'non-cdp-complete',
          discovery: {
            schemaVersion: 1,
            capturedAt: new Date().toISOString(),
            candidates: [
              {
                id: 'caption-source-1',
                videoId: 'video-1',
                kind: 'resource-url',
                format: 'unknown',
                url: 'https://captions.example/subtitles?token=do-not-display',
                displayUrl: 'https://captions.example/subtitles',
                confidence: 'low',
                timing: 'unknown',
                evidence: [],
              },
            ],
            limitations: [],
          },
          retrievals: {
            'caption-source-1': {
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
            },
          },
          retrievingCandidateIds: [],
          diagnostics: {
            responsesObserved: 0,
            bodiesRead: 0,
            bodyReadFailures: 0,
            candidatesAccepted: 0,
            ignoredByReason: {},
          },
          updatedAt: new Date().toISOString(),
        },
      });
      await Promise.resolve();
    });

    expect(screen.getByText('Stage: request')).toBeTruthy();
    expect(
      screen.getByText('Endpoint: https://captions.example (query and path omitted)'),
    ).toBeTruthy();
    expect(
      screen.getByText(/No HTTP response was exposed.*CORS, DNS, TLS, or another network failure/),
    ).toBeTruthy();
    expect(screen.queryByText(/do-not-display/)).toBeNull();
  });
});
