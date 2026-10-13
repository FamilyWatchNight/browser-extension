import type { CaptionSourceCandidate, CaptionSourceFormat } from '../messages';

import { normalizeCaptionPayload } from './caption-normalize';

export function validateCaptionPayload(
  url: string,
  contentType: string | undefined,
  payload: string,
): CaptionSourceFormat | undefined {
  if (isKnownNonTextMimeType(contentType)) return undefined;

  const format = detectBodyFormat(payload);
  if (!format) return undefined;

  try {
    const candidate: CaptionSourceCandidate = {
      id: 'cdp-validation',
      videoId: 'cdp-validation',
      kind: 'resource-url',
      format,
      url: undefined,
      confidence: 'high',
      timing: 'exact',
      evidence: [],
    };
    const normalized = normalizeCaptionPayload(payload, candidate, {
      contentType: contentTypeForFormat(format, contentType),
      sourceUrl: url,
    });
    return normalized.cues.length > 0 ? format : undefined;
  } catch {
    return undefined;
  }
}

export function isWorthReadingCaptionResponse(
  url: string,
  contentType: string | undefined,
  resourceType: string | undefined,
): boolean {
  const mimeType = contentType?.split(';', 1)[0].trim();
  if (isKnownNonTextMimeType(mimeType)) return false;
  if (hasCaptionUrlHint(url)) return true;
  if (mimeType && /^(text\/|application\/(?:json|xml|ttml|vtt))/i.test(mimeType)) {
    return true;
  }
  return !contentType && (resourceType === 'XHR' || resourceType === 'Fetch');
}

function detectBodyFormat(payload: string): CaptionSourceFormat | undefined {
  const body = payload.replace(/^\uFEFF/, '').trimStart();
  if (/^WEBVTT(?:\s|$)/i.test(body)) return 'webvtt';
  if (/^(?:<\?xml\b[^>]*>\s*)?<tt(?:\s|>)/i.test(body) && /<p\b[^>]*\bbegin\s*=/i.test(body)) {
    return 'ttml';
  }
  if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(body)) {
    return 'srt';
  }
  if (/^(?:\[|\{)/.test(body)) {
    try {
      const value: unknown = JSON.parse(body);
      return containsTimedEvents(value) ? 'json' : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function containsTimedEvents(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTimedEvents);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    ['events', 'cues', 'segments'].some(
      (key) => Array.isArray(record[key]) && (record[key] as unknown[]).some(isTimedEvent),
    )
  ) {
    return true;
  }
  return Object.values(record).some(containsTimedEvents);
}

function isTimedEvent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const hasStart =
    record.tStartMs !== undefined ||
    record.startMs !== undefined ||
    record.start !== undefined ||
    record.begin !== undefined;
  const hasDurationOrEnd =
    record.dDurationMs !== undefined ||
    record.durationMs !== undefined ||
    record.duration !== undefined ||
    record.end !== undefined ||
    record.endMs !== undefined;
  const hasText =
    typeof record.text === 'string' ||
    (Array.isArray(record.segs) &&
      record.segs.some(
        (segment) =>
          Boolean(segment) &&
          typeof segment === 'object' &&
          typeof (segment as { utf8?: unknown }).utf8 === 'string',
      ));
  return hasStart && hasDurationOrEnd && hasText;
}

function isKnownNonTextMimeType(contentType?: string): boolean {
  const mimeType = contentType?.split(';', 1)[0].trim();
  return Boolean(
    mimeType &&
      /^(?:font\/|image\/|audio\/|video\/|application\/(?:font-|x-font|zip|gzip|pdf|wasm))/i.test(
        mimeType,
      ),
  );
}

function hasCaptionUrlHint(url: string): boolean {
  return /(?:vtt|webvtt|ttml|dfxp|stpp|wvtt|subrip|subtitle|caption|timedtext|texttrack|\.srt(?:$|[?#])|\.json(?:$|[?#])|\.xml(?:$|[?#]))/i.test(
    url,
  );
}

function contentTypeForFormat(format: CaptionSourceFormat, contentType?: string): string {
  if (contentType) return contentType;
  if (format === 'json') return 'application/json';
  if (format === 'ttml') return 'application/ttml+xml';
  if (format === 'webvtt') return 'text/vtt';
  return 'text/plain';
}
