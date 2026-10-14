import { describe, expect, it } from 'vitest';

import type { PlaybackTraceEvent } from '../../shared/messages';
import {
  getPlaybackTraceEventSize,
  getPlaybackTraceLimitReason,
  PLAYBACK_TRACE_MAX_BYTES,
  PLAYBACK_TRACE_MAX_EVENTS,
  redactPlaybackTraceUrl,
} from '../../shared/utils/playback-trace';

describe('playback trace utilities', () => {
  it('removes query secrets and masks opaque path identifiers', () => {
    expect(
      redactPlaybackTraceUrl(
        'https://media.example/dash/7f1d9b61-4d25-4f17-a053-e710a76db19b/track.m4s?token=private',
      ),
    ).toBe('https://media.example/dash/<redacted>/track.m4s');
  });

  it('accounts for the UTF-8 serialized event size', () => {
    const event: PlaybackTraceEvent = {
      sequence: 1,
      timestamp: '2026-10-13T17:00:00.000Z',
      elapsedMs: 0,
      category: 'interaction',
      name: 'page_click',
      interaction: {
        type: 'click',
        isTrusted: true,
        targetTag: 'button',
        clientX: 18,
        clientY: 32,
        button: 0,
      },
    };
    expect(getPlaybackTraceEventSize(event)).toBe(
      new TextEncoder().encode(JSON.stringify(event)).byteLength + 1,
    );
  });

  it('enforces event and serialized-byte hard caps', () => {
    expect(getPlaybackTraceLimitReason(PLAYBACK_TRACE_MAX_EVENTS, 0, 1)).toBe('event-limit');
    expect(getPlaybackTraceLimitReason(0, PLAYBACK_TRACE_MAX_BYTES, 1)).toBe('size-limit');
    expect(getPlaybackTraceLimitReason(PLAYBACK_TRACE_MAX_EVENTS - 1, 0, 1)).toBeUndefined();
    expect(getPlaybackTraceLimitReason(0, PLAYBACK_TRACE_MAX_BYTES - 1, 1)).toBeUndefined();
  });
});
