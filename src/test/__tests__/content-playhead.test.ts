import { describe, expect, it } from 'vitest';

import type { VideoElement } from '../../shared/messages';
import {
  formatPlaybackTime,
  getInterpolatedContentTime,
  updateContentPlayhead,
} from '../../shared/utils/content-playhead';

function video(overrides: Partial<VideoElement> = {}): VideoElement {
  return {
    id: 'content',
    src: 'blob:content',
    title: 'Movie',
    duration: 3600,
    currentTime: 120,
    paused: false,
    frameIndex: 0,
    width: 1280,
    height: 720,
    isVisible: true,
    hasSource: true,
    readyState: 4,
    playbackRate: 1,
    seeking: false,
    ...overrides,
  };
}

describe('content playhead', () => {
  it('prefers the longer content timeline over a separate short active video', () => {
    const content = video({ currentTime: 120, paused: true });
    const ad = video({
      id: 'short',
      duration: 30,
      currentTime: 10,
      paused: false,
      width: 1280,
      height: 720,
    });

    const state = updateContentPlayhead(undefined, [ad, content], 1000);

    expect(state).toMatchObject({
      videoId: 'content',
      currentTime: 120,
      duration: 3600,
      playing: false,
    });
  });

  it('holds content time through a shorter same-element timeline and resumes at content time', () => {
    const initial = updateContentPlayhead(undefined, [video()], 1000)!;
    const duringAd = updateContentPlayhead(
      initial,
      [video({ duration: 30, currentTime: 12 })],
      2000,
    )!;
    const resumed = updateContentPlayhead(
      duringAd,
      [video({ currentTime: 121, duration: 3600 })],
      3000,
    )!;

    expect(duringAd).toMatchObject({
      currentTime: 120,
      duration: 3600,
      suspended: true,
      playing: false,
    });
    expect(resumed).toMatchObject({
      currentTime: 121,
      duration: 3600,
      suspended: false,
      playing: true,
    });
  });

  it('anchors to the long content timeline after startup clip timelines', () => {
    const firstClip = updateContentPlayhead(
      undefined,
      [video({ duration: 15, currentTime: 14 })],
      1000,
    )!;
    const secondClip = updateContentPlayhead(
      firstClip,
      [video({ duration: 75, currentTime: 0 })],
      2000,
    )!;
    const movie = updateContentPlayhead(
      secondClip,
      [video({ duration: 3600, currentTime: 314 })],
      3000,
    )!;

    expect(secondClip.suspended).toBe(true);
    expect(movie).toMatchObject({
      currentTime: 314,
      duration: 3600,
      suspended: false,
      confidence: 'high',
    });
  });

  it('follows a seek on the content timeline and interpolates between samples', () => {
    const initial = updateContentPlayhead(undefined, [video()], 1000)!;
    const seek = updateContentPlayhead(
      initial,
      [video({ currentTime: 45, seeking: true })],
      2000,
    )!;

    expect(seek.currentTime).toBe(45);
    expect(getInterpolatedContentTime(seek, 2500)).toBe(45);
    const playing = updateContentPlayhead(
      seek,
      [video({ currentTime: 45, seeking: false })],
      3000,
    )!;
    expect(getInterpolatedContentTime(playing, 3500)).toBe(45.5);
  });

  it('formats elapsed time with optional hours and rounded tenths', () => {
    expect(formatPlaybackTime(65.96, true)).toBe('1:06.0');
    expect(formatPlaybackTime(65.96, false)).toBe('1:06');
    expect(formatPlaybackTime(3661.2, true)).toBe('1:01:01.2');
    expect(formatPlaybackTime(Number.NaN, true)).toBe('--:--');
  });
});
