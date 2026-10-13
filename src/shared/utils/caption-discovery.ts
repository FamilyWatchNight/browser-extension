import type {
  CaptionDiscoveryResponse,
  CaptionSourceCandidate,
  CaptionSourceEvidence,
  CaptionSourceFormat,
} from '../messages';

import { deepQuerySelector } from './dom-query';

const MAX_SCRIPT_BYTES = 512_000;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_STRINGS = 200;
const timedTextPattern =
  /(?:\.vtt(?:$|[?#])|\.webvtt(?:$|[?#])|\.ttml2?(?:$|[?#])|\.dfxp(?:$|[?#])|\.srt(?:$|[?#])|timedtext|caption|subtitle|subtitles|texttrack|\/stpp(?:\/|$)|\/wvtt(?:\/|$))/i;
const captionKeyPattern = /caption|subtitle|timedtext|texttrack|closed.?caption/i;

export function isLikelyCaptionResourceUrl(url: string): boolean {
  return timedTextPattern.test(url);
}

export function createCaptionResourceCandidate(
  url: string,
  videoId: string,
): Omit<CaptionSourceCandidate, 'id'> {
  return {
    videoId,
    kind: 'resource-url',
    format: detectFormat(url),
    url,
    displayUrl: redactUrl(url),
    confidence: 'low',
    timing: 'unknown',
    evidence: [{ description: 'Resource timing entry matched timed-text URL heuristics' }],
    limitations: [
      'The resource URL is a heuristic match; its response body has not been inspected.',
    ],
  };
}

export function collectCaptionSourceDiscovery(
  videos: Array<{ id: string; element: HTMLVideoElement }>,
  root: Document = document,
): CaptionDiscoveryResponse {
  const candidates: CaptionSourceCandidate[] = [];
  const limitations: string[] = [];
  const addCandidate = (candidate: Omit<CaptionSourceCandidate, 'id'>) => {
    if (hasDuplicateCandidate(candidates, candidate)) return;
    candidates.push({ ...candidate, id: `caption-source-${candidates.length + 1}` });
  };

  videos.forEach(({ id, element }) => {
    collectNativeTrackCandidates(id, element, addCandidate);
  });

  collectResourceCandidates(videos[0]?.id || 'unknown-video', root, addCandidate);
  collectJsonCandidates(videos[0]?.id || 'unknown-video', root, addCandidate);
  collectDomCandidates(videos, root, addCandidate);

  if (root.querySelector('iframe')) {
    limitations.push('Cross-origin iframe content may not be discoverable from this context.');
  }
  if (deepQuerySelector('video').length === 0 && videos.length > 0) {
    limitations.push('Some videos may be inside closed shadow roots and are not inspectable.');
  }

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    pageUrl: root.location?.href,
    candidates,
    limitations,
  };
}

function collectNativeTrackCandidates(
  videoId: string,
  video: HTMLVideoElement,
  addCandidate: (candidate: Omit<CaptionSourceCandidate, 'id'>) => void,
) {
  const sourceTracks = Array.from(video.querySelectorAll('track'));
  sourceTracks.forEach((sourceTrack, index) => {
    const track = sourceTrack.track || video.textTracks[index];
    const url = sourceTrack.src || undefined;
    const cueCount = track?.cues?.length;
    const activeCueCount = track?.activeCues?.length;
    const evidence: CaptionSourceEvidence[] = [
      {
        description: `HTML track element exposed (${sourceTrack.kind || 'text'}), mode=${track?.mode || 'unavailable'}, readyState=${sourceTrack.readyState}`,
        selector: 'video > track',
      },
      {
        description: `cueCount=${cueCount ?? 'unavailable'}, activeCueCount=${activeCueCount ?? 'unavailable'}`,
      },
      {
        description: `source=${url ? 'available' : 'unavailable'}, default=${sourceTrack.default}`,
      },
    ];

    addCandidate({
      videoId,
      nativeTrackIndex: index,
      kind: 'native-track',
      format: detectFormat(url),
      url,
      displayUrl: redactUrl(url),
      language: track?.language || sourceTrack.srclang || undefined,
      label: track?.label || sourceTrack.label || undefined,
      confidence: 'high',
      timing: cueCount ? 'exact' : 'unknown',
      evidence,
      limitations: cueCount
        ? undefined
        : [
            'The track exists, but the browser exposed no cues at probe time. It may be a placeholder or use another rendering path.',
          ],
    });
  });

  for (let index = sourceTracks.length; index < video.textTracks.length; index += 1) {
    const track = video.textTracks[index];
    const cueCount = track.cues?.length;
    addCandidate({
      videoId,
      nativeTrackIndex: index,
      kind: 'native-track',
      format: 'unknown',
      language: track.language || undefined,
      label: track.label || undefined,
      confidence: 'medium',
      timing: cueCount ? 'exact' : 'unknown',
      evidence: [
        {
          description: `HTML media text track exposed (${track.kind || 'text'}), mode=${track.mode}, readyState=unavailable`,
        },
        {
          description: `cueCount=${cueCount ?? 'unavailable'}, activeCueCount=${track.activeCues?.length ?? 'unavailable'}`,
        },
      ],
      limitations: cueCount
        ? ['The browser exposed a track, but no fetchable source URL was exposed.']
        : ['The browser exposed a zero-cue track with no fetchable source URL.'],
    });
  }
}

function collectResourceCandidates(
  videoId: string,
  root: Document,
  addCandidate: (candidate: Omit<CaptionSourceCandidate, 'id'>) => void,
) {
  const entries = root.defaultView?.performance.getEntriesByType('resource') || [];
  entries.forEach((entry) => {
    const url = (entry as PerformanceResourceTiming).name;
    if (!isLikelyCaptionResourceUrl(url)) return;
    addCandidate(createCaptionResourceCandidate(url, videoId));
  });
}

function collectJsonCandidates(
  videoId: string,
  root: Document,
  addCandidate: (candidate: Omit<CaptionSourceCandidate, 'id'>) => void,
) {
  const scripts = root.querySelectorAll<HTMLScriptElement>(
    'script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__, script#__INITIAL_STATE__',
  );
  scripts.forEach((script) => {
    const text = script.textContent || '';
    if (text.length > MAX_SCRIPT_BYTES) return;
    try {
      const value: unknown = JSON.parse(text);
      walkJson(value, 0, [], (url, fieldPath) => {
        addCandidate({
          videoId,
          kind: 'provider-data',
          format: detectFormat(url),
          url,
          displayUrl: redactUrl(url),
          confidence: 'medium',
          timing: 'unknown',
          evidence: [
            {
              description: 'Caption-like URL found in page JSON',
              fieldPath,
            },
          ],
          limitations: ['The URL was discovered in page data; the payload has not been retrieved.'],
        });
      });
    } catch {
      // Ignore non-JSON script content.
    }
  });
}

function collectDomCandidates(
  videos: Array<{ id: string; element: HTMLVideoElement }>,
  root: Document,
  addCandidate: (candidate: Omit<CaptionSourceCandidate, 'id'>) => void,
) {
  const elements = deepQuerySelector(
    '[class*="caption" i], [class*="subtitle" i], [class*="timedtext" i], [aria-label*="caption" i], [aria-label*="subtitle" i]',
    root,
  );
  if (elements.length === 0) return;

  const videoId = videos[0]?.id || 'unknown-video';
  const hasText = elements.some((element) => Boolean(element.textContent?.trim()));
  addCandidate({
    videoId,
    kind: 'dom-sample',
    format: 'unknown',
    confidence: hasText ? 'low' : 'medium',
    timing: 'sampled',
    evidence: elements.slice(0, 5).map((element) => ({
      description: hasText
        ? 'Caption-like DOM text surface found'
        : 'Caption-like DOM surface found',
      selector: describeElement(element),
    })),
    limitations: [
      'DOM observations do not provide complete bulk captions or exact cue boundaries.',
      'This candidate requires an opt-in realtime sampler.',
    ],
  });
}

function walkJson(
  value: unknown,
  depth: number,
  path: string[],
  onUrl: (url: string, fieldPath: string) => void,
  state = { strings: 0 },
) {
  if (depth > MAX_JSON_DEPTH || state.strings >= MAX_JSON_STRINGS) return;
  if (typeof value === 'string') {
    state.strings += 1;
    if (captionKeyPattern.test(path[path.length - 1] || '') && isHttpUrl(value)) {
      onUrl(value, path.join('.'));
    } else if (timedTextPattern.test(value) && isHttpUrl(value)) {
      onUrl(value, path.join('.'));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walkJson(item, depth + 1, [...path, String(index)], onUrl, state),
    );
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, item]) => {
    walkJson(item, depth + 1, [...path, key], onUrl, state);
  });
}

function detectFormat(url?: string): CaptionSourceFormat {
  if (!url) return 'unknown';
  if (/\.vtt(?:$|[?#])|webvtt|wvtt/i.test(url)) return 'webvtt';
  if (/\.ttml2?(?:$|[?#])|\.dfxp(?:$|[?#])|ttml|stpp/i.test(url)) return 'ttml';
  if (/\.srt(?:$|[?#])/i.test(url)) return 'srt';
  if (/\.json(?:$|[?#])/i.test(url)) return 'json';
  return 'unknown';
}

function redactUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|signature|sig|auth|expires|exp|key/i.test(key))
        parsed.searchParams.set(key, '[redacted]');
    }
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function hasDuplicateCandidate(
  candidates: CaptionSourceCandidate[],
  candidate: Omit<CaptionSourceCandidate, 'id'>,
): boolean {
  return candidates.some(
    (existing) =>
      existing.videoId === candidate.videoId &&
      existing.kind === candidate.kind &&
      existing.url === candidate.url &&
      existing.format === candidate.format,
  );
}

function describeElement(element: Element): string {
  const id = element.id ? `#${element.id}` : '';
  const className =
    typeof element.className === 'string' && element.className
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
  return `${element.tagName.toLowerCase()}${id}${className}`;
}
