import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVideoElementSnapshot, setupVideoListeners } from '../../shared/utils/video-element';

function setMediaState(
  video: HTMLVideoElement,
  state: { duration: number; currentTime: number; paused: boolean },
) {
  Object.defineProperties(video, {
    duration: { configurable: true, value: state.duration },
    currentTime: { configurable: true, value: state.currentTime },
    paused: { configurable: true, value: state.paused },
  });
}

describe('video-element', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.title = '';
  });

  it('creates a snapshot from the video and document metadata', () => {
    document.title = 'Family Watch';
    const video = document.createElement('video');
    video.title = 'Episode one';
    video.src = 'https://example.test/episode.mp4';
    setMediaState(video, { duration: 120, currentTime: 35, paused: false });

    const snapshot = createVideoElementSnapshot(video, 2);

    expect(snapshot).toMatchObject({
      src: 'https://example.test/episode.mp4',
      title: 'Episode one',
      duration: 120,
      currentTime: 35,
      paused: false,
      frameIndex: 2,
    });
    expect(snapshot.id).toMatch(/^video-/);
  });

  it('uses source and document title fallbacks', () => {
    document.title = 'Family Watch';
    const video = document.createElement('video');
    const source = document.createElement('source');
    source.src = 'episode.mp4';
    video.appendChild(source);
    setMediaState(video, { duration: NaN, currentTime: NaN, paused: true });

    const snapshot = createVideoElementSnapshot(video);

    expect(snapshot.src).toBe('http://localhost:3000/episode.mp4');
    expect(snapshot.title).toBe('Family Watch');
    expect(snapshot.duration).toBe(0);
    expect(snapshot.currentTime).toBe(0);
  });

  it('reports current media state for supported events', () => {
    const video = document.createElement('video');
    setMediaState(video, { duration: 10, currentTime: 1, paused: true });
    const onUpdate = vi.fn();
    const cleanup = setupVideoListeners(video, onUpdate);

    setMediaState(video, { duration: 90, currentTime: 12, paused: false });
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('pause'));
    video.dispatchEvent(new Event('timeupdate'));
    video.dispatchEvent(new Event('play'));

    expect(onUpdate).toHaveBeenCalledTimes(4);
    expect(onUpdate).toHaveBeenLastCalledWith({ duration: 90, currentTime: 12, paused: false });

    cleanup();
    video.dispatchEvent(new Event('timeupdate'));
    expect(onUpdate).toHaveBeenCalledTimes(4);
  });
});
