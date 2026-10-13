import type {
  CaptionFailureCategory,
  CaptionRetrievalFailureDiagnostics,
  CaptionSourceFormat,
} from '../messages';

export const MAX_CAPTION_BYTES = 10 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;

export class CaptionFetchError extends Error {
  constructor(
    message: string,
    readonly category: CaptionFailureCategory,
    readonly diagnostics: CaptionRetrievalFailureDiagnostics,
  ) {
    super(message);
    this.name = 'CaptionFetchError';
  }
}

export function validateCaptionUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username || url.password) return undefined;
    if (isPrivateHost(url.hostname)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function detectCaptionFormat(
  url: string | undefined,
  contentType: string | undefined,
  payload: string,
): CaptionSourceFormat {
  const hints = `${url || ''} ${contentType || ''}`.toLowerCase();
  if (
    hints.includes('webvtt') ||
    /(?:\.vtt|\.webvtt|wvtt)(?:$|[?#\s])/i.test(hints) ||
    /^\s*WEBVTT/i.test(payload)
  ) {
    return 'webvtt';
  }
  if (
    hints.includes('ttml') ||
    hints.includes('dfxp') ||
    hints.includes('stpp') ||
    /(?:\.ttml2?|\.dfxp)(?:$|[?#\s])/i.test(hints) ||
    /^\s*(?:<\?xml[^>]*>\s*)?<tt[\s>]/i.test(payload)
  ) {
    return 'ttml';
  }
  if (
    hints.includes('srt') ||
    /\.srt(?:$|[?#\s])/i.test(hints) ||
    /^\s*1\s*\r?\n\d{2}:\d{2}/.test(payload)
  ) {
    return 'srt';
  }
  if (hints.includes('json') || /^\s*[[]{/.test(payload)) return 'json';
  return 'unknown';
}

export async function fetchCaptionPayload(url: string): Promise<{
  payload: string;
  contentType?: string;
  byteLength: number;
  finalUrl: string;
}> {
  const validatedUrl = validateCaptionUrl(url);
  if (!validatedUrl) {
    throw new CaptionFetchError(
      'Caption URL is not an allowed HTTP(S) resource',
      'inaccessible',
      { stage: 'url-validation' },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(validatedUrl, {
        credentials: 'omit',
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut =
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === 'AbortError');
      throw new CaptionFetchError(
        timedOut
          ? `Caption request timed out after ${FETCH_TIMEOUT_MS} ms`
          : 'Browser fetch failed before an HTTP response was available',
        timedOut ? 'timeout' : 'network',
        { stage: 'request', endpoint: validatedUrl.origin },
      );
    }

    const responseDiagnostics = {
      stage: 'response' as const,
      endpoint: validatedUrl.origin,
      httpStatus: response.status,
      contentType: sanitizeContentType(response.headers.get('content-type')),
    };
    if (!response.ok) {
      const category: CaptionFailureCategory =
        response.status === 401 || response.status === 403 ? 'auth' : 'network';
      throw new CaptionFetchError(
        `Caption request failed with HTTP ${response.status}`,
        category,
        responseDiagnostics,
      );
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CAPTION_BYTES) {
      throw new CaptionFetchError(
        `Caption response exceeds ${MAX_CAPTION_BYTES} bytes`,
        'size-limit',
        { ...responseDiagnostics, responseBytes: declaredLength },
      );
    }

    let payload: string;
    try {
      payload = await response.text();
    } catch {
      throw new CaptionFetchError(
        'The response was received, but its body could not be read',
        'network',
        responseDiagnostics,
      );
    }
    const byteLength = new TextEncoder().encode(payload).byteLength;
    if (byteLength > MAX_CAPTION_BYTES) {
      throw new CaptionFetchError(
        `Caption response exceeds ${MAX_CAPTION_BYTES} bytes`,
        'size-limit',
        { ...responseDiagnostics, responseBytes: byteLength },
      );
    }
    return {
      payload,
      contentType: responseDiagnostics.contentType,
      byteLength,
      finalUrl: response.url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeContentType(contentType: string | null): string | undefined {
  return contentType?.split(';', 1)[0]?.trim() || undefined;
}

function isPrivateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized.endsWith('.localhost'))
    return true;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\./.test(normalized)) return true;
  const match = normalized.match(/^172\.(\d{1,3})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}
