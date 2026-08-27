import { act, render, screen } from '@testing-library/react';
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
});
