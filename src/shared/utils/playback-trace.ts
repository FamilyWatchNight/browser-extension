import type { PlaybackTraceEndReason, PlaybackTraceEvent } from '../messages';

export const PLAYBACK_TRACE_MAX_DURATION_MS = 150 * 60 * 1000;
export const PLAYBACK_TRACE_MAX_BYTES = 8 * 1024 * 1024;
export const PLAYBACK_TRACE_MAX_EVENTS = 50_000;
export const PLAYBACK_TRACE_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const PLAYBACK_TRACE_MAX_MANIFEST_BYTES = 1024 * 1024;
export const PLAYBACK_TRACE_MAX_YOUTUBE_RESPONSE_BYTES = 512 * 1024;
export const PLAYBACK_TRACE_MAX_YOUTUBE_SUMMARY_FIELDS = 100;
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

export function summarizeYouTubeAdResponse(
  source: string,
): { fields: Array<{ path: string; value: number | boolean | string }>; truncated: boolean } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;

  const fields: Array<{ path: string; value: number | boolean | string }> = [];
  const stack: Array<{ value: unknown; path: string; adContext: boolean; depth: number }> = [
    { value: parsed, path: '', adContext: false, depth: 0 },
  ];
  let visited = 0;
  let truncated = false;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (++visited > 20_000 || current.depth > 20) {
      truncated = true;
      break;
    }

    if (Array.isArray(current.value)) {
      if (current.value.length > 20_000) truncated = true;
      for (let index = Math.min(current.value.length, 20_000) - 1; index >= 0; index--) {
        stack.push({
          value: current.value[index],
          path: `${current.path}[${index}]`,
          adContext: current.adContext,
          depth: current.depth + 1,
        });
      }
      continue;
    }
    if (!current.value || typeof current.value !== 'object') continue;

    const entries = Object.entries(current.value);
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const [key, value] = entries[entryIndex];
      const normalizedKey = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      if (
        !/^[\w.-]{1,64}$/.test(key) ||
        /(?:^|_)(?:id|url|uri|token|auth|secret|cookie|session|signature|credential)(?:_|$)/i.test(
          normalizedKey,
        )
      ) {
        continue;
      }
      const keySignalsAd =
        /(?:^|_)(?:ad|ads|break|slot|placement|sponsor|monetiz|eligib|decision|serv|skip|insert|cuepoint)(?:_|$)/i.test(
          normalizedKey,
        );
      const adContext =
        current.adContext ||
        /(?:^|_)(?:ad|ads|break|slot|placement|sponsor|monetiz|cuepoint)(?:_|$)/i.test(
          normalizedKey,
        );
      const timingKey =
        /(?:time|duration|offset|position|seek|start|schedule|playhead|clock|timestamp)/i.test(
          normalizedKey,
        );
      const path = current.path ? `${current.path}.${key}` : key;
      if (path.length > 240) {
        truncated = true;
        continue;
      }

      let safeValue: number | boolean | string | undefined;
      const numericValue =
        typeof value === 'number'
          ? value
          : typeof value === 'string' &&
              /^-?\d{1,10}(?:\.\d{1,6})?$/.test(value)
            ? Number(value)
            : undefined;
      if (
        numericValue !== undefined &&
        Number.isFinite(numericValue) &&
        Math.abs(numericValue) <= 1_000_000_000
      ) {
        if (timingKey && (current.adContext || keySignalsAd)) safeValue = numericValue;
      } else if (typeof value === 'boolean') {
        if (
          keySignalsAd ||
          (adContext && /eligible|available|decision|serve|skip|enabled|selected/i.test(normalizedKey))
        ) {
          safeValue = value;
        }
      } else if (typeof value === 'string' && keySignalsAd) {
        safeValue = getSafeAdCategory(value);
      }

      if (safeValue !== undefined) {
        if (fields.length >= PLAYBACK_TRACE_MAX_YOUTUBE_SUMMARY_FIELDS) {
          truncated = true;
          break;
        }
        fields.push({ path, value: safeValue });
      }
      if (value && typeof value === 'object') {
        stack.push({ value, path, adContext, depth: current.depth + 1 });
      }
      if (
        fields.length >= PLAYBACK_TRACE_MAX_YOUTUBE_SUMMARY_FIELDS &&
        (entryIndex < entries.length - 1 || stack.length > 0)
      ) {
        truncated = true;
      }
    }
    if (fields.length >= PLAYBACK_TRACE_MAX_YOUTUBE_SUMMARY_FIELDS) break;
  }

  return { fields, truncated };
}

function getSafeAdCategory(value: string): string | undefined {
  const words = value.toLowerCase().match(/[a-z]+/g) || [];
  const allowedCategory =
    /^(?:pre|mid|post)_?roll$|^(?:linear|nonlinear|skippable|non_skippable|display|overlay|video|audio|instream|outstream|bumper|unknown|eligible|ineligible|served|not_served|selected|rejected|true|false)$/;
  return [words[words.length - 1], words.slice(-2).join('_')].find(
    (category): category is string => Boolean(category && allowedCategory.test(category)),
  );
}

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
