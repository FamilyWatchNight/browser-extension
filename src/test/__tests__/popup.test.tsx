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
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      200,
      0,
      1200,
      900,
      0,
      0,
      1200,
      900,
    );
    expect(chromeFixture.chrome.downloads.download).toHaveBeenCalledWith({
      url: 'data:image/jpeg;base64,cropped-tab',
      filename: expect.stringMatching(/^screenshot-.*\.jpg$/),
      conflictAction: 'uniquify',
      saveAs: false,
    });
  });
});
