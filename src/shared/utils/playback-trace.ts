import type { PlaybackTraceEndReason, PlaybackTraceEvent } from '../messages';

export const PLAYBACK_TRACE_MAX_DURATION_MS = 150 * 60 * 1000;
export const PLAYBACK_TRACE_MAX_BYTES = 8 * 1024 * 1024;
export const PLAYBACK_TRACE_MAX_EVENTS = 50_000;
export const PLAYBACK_TRACE_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const PLAYBACK_TRACE_MAX_MANIFEST_BYTES = 1024 * 1024;
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

export type PlaybackManifestFormat = 'dash-mpd' | 'hls';

export function sanitizePlaybackManifest(
  value: string,
): { format: PlaybackManifestFormat; text: string; byteLength: number } | undefined {
  const source = value.replace(/^\uFEFF/, '');
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > PLAYBACK_TRACE_MAX_MANIFEST_BYTES || /<!DOCTYPE|<!ENTITY/i.test(source)) {
    return;
  }

  const mpdRoot = source.match(
    /^(?:\s*<\?xml\b[^>]*\?>)?\s*(?:<!--[\s\S]*?-->\s*)*<((?:[\w.-]+:)?MPD)\b/i,
  );
  if (mpdRoot && new RegExp(`<\\/${mpdRoot[1]}\\s*>`, 'i').test(source)) {
    const text = sanitizeDashManifest(source);
    return { format: 'dash-mpd', text, byteLength: new TextEncoder().encode(text).byteLength };
  }

  if (/^\s*#EXTM3U(?:\s|$)/.test(source)) {
    const text = sanitizeHlsManifest(source);
    return { format: 'hls', text, byteLength: new TextEncoder().encode(text).byteLength };
  }
}

function sanitizeDashManifest(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<(?:[\w.-]+:)?ContentProtection\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?ContentProtection\s*>/gi,
      '',
    )
    .replace(
      /<(?:[\w.-]+:)?(?:pssh|Laurl|license)\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?(?:pssh|Laurl|license)\s*>/gi,
      '',
    )
    .replace(
      /<(?:[\w.-]+:)?(?:ContentProtection|pssh|Laurl|license|License)\b[^>]*\/\s*>/gi,
      '',
    )
    .replace(
      /(<(?:[\w.-]+:)?(?:BaseURL|Location|PatchLocation|UTCTiming)\b[^>]*>)[\s\S]*?(<\/(?:[\w.-]+:)?(?:BaseURL|Location|PatchLocation|UTCTiming)\s*>)/gi,
      '$1[redacted]$2',
    )
    .replace(
      /(<(?:[\w.-]+:)?UTCTiming\b[^>]*\bvalue\s*=\s*)(["'])[^"']*\2/gi,
      (_match, prefix: string, quote: string) => `${prefix}${quote}[redacted]${quote}`,
    )
    .replace(
      /\b(media|initialization|sourceURL|href|xlink:href|url|licenseUrl|keyUri)\s*=\s*(["'])[^"']*\2/gi,
      (_match, name: string, quote: string) => `${name}=${quote}[redacted]${quote}`,
    )
    .replace(
      /\b(?:xsi:)?schemaLocation\s*=\s*(["'])[^"']*\1/gi,
      (_match, quote: string) => `schemaLocation=${quote}[redacted]${quote}`,
    )
    .replace(
      /(\b[\w:.-]+\s*=\s*)(["'])([^"']*)\2/gi,
      (match, prefix: string, quote: string, value: string) =>
        !/^xmlns(?::|$)/i.test(prefix) && /^(?:https?:)?\/\//i.test(value)
          ? `${prefix}${quote}[redacted]${quote}`
          : match,
    )
    .replace(
      /(\b[\w:.-]*(?:token|signature|auth|credential|secret|cookie|session)[\w:.-]*\s*=\s*)(["'])[^"']*\2/gi,
      (_match, prefix: string, quote: string) => `${prefix}${quote}[redacted]${quote}`,
    )
    .replace(
      /(\b[\w:.-]+\s*=\s*)(["'])([^"']*\?[^"']*)\2/g,
      (_match, prefix: string, quote: string) => `${prefix}${quote}[redacted]${quote}`,
    )
    .trim();
}

function sanitizeHlsManifest(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => {
      if (!line || line.startsWith('#')) {
        return line.replace(
          /\b(URI|SERVER-URI)\s*=\s*(["'])[^"']*\2/gi,
          (_match, name: string, quote: string) => `${name}=${quote}[redacted]${quote}`,
        ).replace(/\bKEYID\s*=\s*(?:"[^"]*"|'[^']*'|[^,\s]*)/gi, 'KEYID="[redacted]"');
      }
      return '[redacted-uri]';
    })
    .join('\n')
    .trim();
}
