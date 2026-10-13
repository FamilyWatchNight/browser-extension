import type {
  CaptionDiagnosticEvidence,
  CaptionDiagnosticTrack,
  CaptionDiagnosticsResponse,
  VideoCaptionDiagnostics,
} from '../messages';

const captionPattern = /caption|subtitle|closed.?caption|\bcc\b/i;

export function collectCaptionDiagnostics(
  videos: Array<{ id: string; element: HTMLVideoElement }>,
  root: Document = document,
): CaptionDiagnosticsResponse {
  const pageEvidence = collectPageEvidence(root);
  return {
    capturedAt: new Date().toISOString(),
    videos: videos.map(({ id, element }) => collectVideoDiagnostics(id, element, pageEvidence)),
    pageEvidence,
    limitations: collectLimitations(root),
  };
}

function collectVideoDiagnostics(
  videoId: string,
  video: HTMLVideoElement,
  pageEvidence: CaptionDiagnosticEvidence[],
): VideoCaptionDiagnostics {
  const tracks = collectTracks(video);
  const evidence: CaptionDiagnosticEvidence[] = tracks.map((track) => ({
    type: 'native-track',
    description: `Native ${track.kind || 'text'} track${track.language ? ` (${track.language})` : ''} exposed`,
  }));
  const nearbyOverlay = findNearbyOverlay(video);
  if (nearbyOverlay) evidence.push(nearbyOverlay);
  evidence.push(...pageEvidence.filter((item) => item.type === 'player-control'));

  return {
    videoId,
    title: video.title || document.title || 'Unknown Video',
    classification: tracks.length
      ? 'native-track'
      : nearbyOverlay
        ? 'dom-overlay'
        : pageEvidence.some((item) => item.type === 'player-control')
          ? 'player-control'
          : 'unknown',
    tracks,
    evidence: deduplicateEvidence(evidence),
    limitations: [
      'This probe does not inspect network requests, closed shadow roots, or DRM internals.',
      ...(tracks.some((track) => track.readyState !== 2)
        ? ['One or more native tracks are not loaded; cue counts may be unavailable.']
        : []),
    ],
  };
}

function collectTracks(video: HTMLVideoElement): CaptionDiagnosticTrack[] {
  const sourceTracks = Array.from(video.querySelectorAll('track'));
  const tracks: CaptionDiagnosticTrack[] = [];
  for (let index = 0; index < video.textTracks.length; index += 1) {
    const track = video.textTracks[index];
    tracks.push({
      kind: track.kind,
      label: track.label,
      language: track.language,
      mode: track.mode,
      readyState: sourceTracks[index]?.readyState ?? 0,
      source: sourceTracks[index]?.src || '',
      cueCount: track.cues?.length,
    });
  }
  return tracks;
}

function collectPageEvidence(root: Document): CaptionDiagnosticEvidence[] {
  const evidence: CaptionDiagnosticEvidence[] = [];
  const candidates = root.querySelectorAll<HTMLElement>(
    'button, [role="button"], [aria-label], [title], [data-testid], [class*="caption" i], [class*="subtitle" i], [class*="cc" i]',
  );
  candidates.forEach((element) => {
    const text = [
      element.textContent,
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-testid'),
      element.className,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!captionPattern.test(text)) return;
    const isControl =
      element.matches('button, [role="button"]') || element.hasAttribute('aria-label');
    evidence.push({
      type: isControl ? 'player-control' : 'dom-overlay',
      description: `${isControl ? 'Caption control' : 'Caption-like element'}: ${text.slice(0, 160)}`,
      selector: describeElement(element),
    });
  });
  return deduplicateEvidence(evidence);
}

function findNearbyOverlay(video: HTMLVideoElement): CaptionDiagnosticEvidence | undefined {
  const videoRect = video.getBoundingClientRect();
  const parent = video.parentElement;
  if (!parent) return undefined;
  for (const element of parent.querySelectorAll<HTMLElement>('*')) {
    if (element === video || !captionPattern.test(getElementDescription(element))) continue;
    const text = element.textContent?.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 300) continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom >= videoRect.top && rect.top <= videoRect.bottom) {
      return {
        type: 'dom-overlay',
        description: `Caption-like text near video: ${text.slice(0, 160)}`,
        selector: describeElement(element),
      };
    }
  }
  return undefined;
}

function collectLimitations(root: Document): string[] {
  const limitations = ['Results are passive observations and do not prove captions are active.'];
  if (root.querySelector('iframe'))
    limitations.push('Cross-origin iframe content may be inaccessible to this probe.');
  return limitations;
}

function getElementDescription(element: Element): string {
  return [element.textContent, element.getAttribute('aria-label'), element.getAttribute('class')]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function describeElement(element: Element): string {
  const id = element.id ? `#${element.id}` : '';
  const className =
    typeof element.className === 'string' && element.className
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
  return `${element.tagName.toLowerCase()}${id}${className}`;
}

function deduplicateEvidence(evidence: CaptionDiagnosticEvidence[]): CaptionDiagnosticEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.type}:${item.description}:${item.selector || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
