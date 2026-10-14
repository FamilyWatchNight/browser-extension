import type { PlaybackTraceEndReason, PlaybackTraceEvent } from '../messages';

export const PLAYBACK_TRACE_MAX_DURATION_MS = 150 * 60 * 1000;
export const PLAYBACK_TRACE_MAX_BYTES = 8 * 1024 * 1024;
export const PLAYBACK_TRACE_MAX_EVENTS = 50_000;
export const PLAYBACK_TRACE_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const PLAYBACK_TRACE_WARNING_RATIO = 0.75;
export const PLAYBACK_TRACE_PERSIST_BATCH_SIZE = 25;
export const PLAYBACK_TRACE_CHUNK_SIZE = 100;
export const PLAYBACK_TRACE_TIME_SAMPLE_INTERVAL_MS = 15_000;

export function getPlaybackTraceEventSize(event: PlaybackTraceEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength + 1;
}

export function getPlaybackTraceLimitReason(
  eventCount: number,
  serializedBytes: number,
  nextEventBytes: number,
): Extract<PlaybackTraceEndReason, 'event-limit' | 'size-limit'> | undefined {
  if (eventCount >= PLAYBACK_TRACE_MAX_EVENTS) return 'event-limit';
  if (serializedBytes + nextEventBytes > PLAYBACK_TRACE_MAX_BYTES) return 'size-limit';
  return undefined;
}

export function redactPlaybackTraceUrl(value: string): string {
  if (value.startsWith('data:')) return 'data:<redacted>';
  if (value.startsWith('blob:')) return 'blob:<redacted>';

  try {
    const url = new URL(value);
    const pathname = url.pathname
      .split('/')
      .map((segment) => {
        if (
          /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(segment) ||
          /^[\da-f]{24,}$/i.test(segment) ||
          /^[a-z\d_-]{24,}$/i.test(segment)
        ) {
          const extension = segment.match(/(\.[a-z\d]{1,8})$/i)?.[1] || '';
          return `<redacted>${extension}`;
        }
        return segment;
      })
      .join('/');
    return `${url.origin}${pathname}`;
  } catch {
    return '<invalid-url>';
  }
}
