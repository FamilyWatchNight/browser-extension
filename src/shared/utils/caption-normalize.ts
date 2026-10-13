import type {
  CaptionConfidence,
  CaptionCue,
  CaptionSourceCandidate,
  NormalizedCaptionDocument,
} from '../messages';

import { detectCaptionFormat } from './caption-fetch';

export function normalizeCaptionPayload(
  payload: string,
  candidate: CaptionSourceCandidate,
  metadata: {
    contentType?: string;
    sourceUrl?: string;
    retrievedAt?: string;
    byteLength?: number;
  } = {},
): NormalizedCaptionDocument {
  const format = detectCaptionFormat(candidate.url, metadata.contentType, payload);
  const warnings: NormalizedCaptionDocument['warnings'] = [];
  let cues: CaptionCue[];

  if (format === 'webvtt') cues = parseWebVtt(payload, warnings);
  else if (format === 'ttml') cues = parseTtml(payload, warnings);
  else if (format === 'srt') cues = parseSrt(payload, warnings);
  else if (format === 'json') cues = parseJsonCaptions(payload, warnings);
  else throw new Error('Unsupported caption format');

  if (cues.length === 0) warnings.push({ code: 'no-cues', message: 'No timed cues were found.' });
  const confidence: CaptionConfidence = candidate.timing === 'exact' ? 'high' : 'medium';
  return {
    schemaVersion: 1,
    documentId: `captions-${Date.now()}`,
    language: candidate.language,
    languageConfidence: candidate.language ? 'high' : 'low',
    title: candidate.label,
    capturedAt: metadata.retrievedAt || new Date().toISOString(),
    cues,
    source: {
      sourceKind: candidate.kind,
      sourceFormat: format,
      sourceUrl: metadata.sourceUrl || candidate.url,
      language: candidate.language,
      label: candidate.label,
      retrievedAt: metadata.retrievedAt || new Date().toISOString(),
      contentType: metadata.contentType,
      authentication: 'unknown',
    },
    uncertainty: {
      confidence,
      timing: candidate.timing,
      inferredFields: [],
      omittedFeatures: format === 'srt' ? ['styling', 'regions'] : [],
      limitations: candidate.limitations || [],
    },
    warnings,
  };
}

export function exportNormalizedWebVtt(document: NormalizedCaptionDocument): string {
  const cues = document.cues
    .map((cue) => {
      const settings = cue.settings
        ? Object.entries(cue.settings)
            .filter(([, value]) => value)
            .map(([key, value]) => `${key}:${value}`)
            .join(' ')
        : '';
      return `${cue.id}\n${formatWebVttTime(cue.start)} --> ${formatWebVttTime(cue.end)}${settings ? ` ${settings}` : ''}\n${cue.text}`;
    })
    .join('\n\n');
  return `WEBVTT\n\n${cues}${cues ? '\n' : ''}`;
}

export function normalizeNativeTrack(
  video: HTMLVideoElement,
  candidate: CaptionSourceCandidate,
): NormalizedCaptionDocument {
  if (candidate.nativeTrackIndex === undefined) throw new Error('Native track index is missing');
  const trackElement = video.querySelectorAll('track')[candidate.nativeTrackIndex];
  const track = trackElement?.track || video.textTracks[candidate.nativeTrackIndex];
  if (!track) throw new Error('Native caption track is no longer available');
  if (!track.cues) throw new Error('Native caption track has not loaded its cues');
  if (track.cues.length === 0) throw new Error('Native caption track loaded but contains no cues');

  const cues: CaptionCue[] = [];
  for (let index = 0; index < track.cues.length; index += 1) {
    const cue = track.cues[index];
    if (
      !Number.isFinite(cue.startTime) ||
      !Number.isFinite(cue.endTime) ||
      cue.endTime <= cue.startTime
    ) {
      continue;
    }
    const cueText = 'text' in cue && typeof cue.text === 'string' ? cue.text : '';
    cues.push({
      id: `cue-${index + 1}`,
      start: cue.startTime,
      end: cue.endTime,
      text: cueText,
      confidence: 'high',
      originalTiming: {
        start: String(cue.startTime),
        end: String(cue.endTime),
      },
    });
  }

  const retrievedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    documentId: `captions-${Date.now()}`,
    language: candidate.language,
    languageConfidence: candidate.language ? 'high' : 'low',
    title: candidate.label,
    capturedAt: retrievedAt,
    cues,
    source: {
      sourceKind: 'native-track',
      sourceFormat: 'webvtt',
      language: candidate.language,
      label: candidate.label,
      retrievedAt,
      contentType: 'text/vtt',
      authentication: 'not-needed',
    },
    uncertainty: {
      confidence: 'high',
      timing: 'exact',
      inferredFields: [],
      omittedFeatures: ['provider-original-payload'],
      limitations: candidate.limitations || [],
    },
    warnings:
      cues.length === 0 ? [{ code: 'no-cues', message: 'No valid native cues were found.' }] : [],
  };
}

function parseWebVtt(
  payload: string,
  warnings: NormalizedCaptionDocument['warnings'],
): CaptionCue[] {
  const blocks = payload.replace(/^\uFEFF?WEBVTT[^\n]*(?:\r?\n|$)/i, '').split(/\r?\n\s*\r?\n/);
  return blocks.flatMap((block, index) => {
    const lines = block.split(/\r?\n/).map((line) => line.trimEnd());
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) return [];
    const match = lines[timingIndex].match(/^(.+?)\s+-->\s+([^\s]+)(?:\s+(.*))?$/);
    if (!match) return [];
    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    if (start === undefined || end === undefined || end <= start) {
      warnings.push({ code: 'invalid-timing', message: `Skipped invalid WebVTT cue ${index + 1}` });
      return [];
    }
    return [
      {
        id: `cue-${index + 1}`,
        start,
        end,
        text: lines.slice(timingIndex + 1).join('\n'),
        settings: parseVttSettings(match[3]),
        confidence: 'high',
        originalTiming: { start: match[1], end: match[2] },
      },
    ];
  });
}

function parseSrt(payload: string, warnings: NormalizedCaptionDocument['warnings']): CaptionCue[] {
  return payload.split(/\r?\n\s*\r?\n/).flatMap((block, index) => {
    const lines = block.split(/\r?\n/);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) return [];
    const match = lines[timingIndex].match(/^(.+?)\s+-->\s+(.+)$/);
    if (!match) return [];
    const start = parseTimestamp(match[1].trim());
    const end = parseTimestamp(match[2].trim());
    if (start === undefined || end === undefined || end <= start) {
      warnings.push({ code: 'invalid-timing', message: `Skipped invalid SRT cue ${index + 1}` });
      return [];
    }
    return [
      {
        id: `cue-${index + 1}`,
        start,
        end,
        text: lines.slice(timingIndex + 1).join('\n'),
        confidence: 'high',
        originalTiming: { start: match[1].trim(), end: match[2].trim() },
      },
    ];
  });
}

function parseTtml(payload: string, warnings: NormalizedCaptionDocument['warnings']): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const paragraphPattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;
  while ((match = paragraphPattern.exec(payload))) {
    const attributes = match[1];
    const startText = readAttribute(attributes, 'begin');
    const endText = readAttribute(attributes, 'end');
    const start = parseTimestamp(startText);
    const end = parseTimestamp(endText);
    if (start === undefined || end === undefined || end <= start) {
      warnings.push({
        code: 'invalid-timing',
        message: 'Skipped TTML paragraph with invalid timing',
      });
      continue;
    }
    const text = decodeXml(
      stripTags(match[2])
        .replace(/\s*\n\s*/g, ' ')
        .trim(),
    );
    cues.push({
      id: `cue-${cues.length + 1}`,
      start,
      end,
      text,
      confidence: 'high',
      originalTiming: { start: startText || '', end: endText || '' },
    });
  }
  return cues;
}

function parseJsonCaptions(
  payload: string,
  warnings: NormalizedCaptionDocument['warnings'],
): CaptionCue[] {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error('Invalid caption JSON');
  }
  const events = findCaptionEvents(value);
  if (!events.length)
    warnings.push({ code: 'unknown-json-shape', message: 'No supported timed event array found.' });
  return events.flatMap((event, index) => {
    const start = numberValue(event.tStartMs ?? event.startMs ?? event.start);
    const duration = numberValue(event.dDurationMs ?? event.durationMs);
    const end =
      numberValue(event.end ?? event.endMs) ??
      (start !== undefined && duration !== undefined ? start + duration : undefined);
    const text = Array.isArray(event.segs)
      ? event.segs.map((segment) => String(segment.utf8 || '')).join('')
      : String(event.text || '');
    if (start === undefined || end === undefined || end <= start || !text) return [];
    return [
      {
        id: `cue-${index + 1}`,
        start: start > 1000 ? start / 1000 : start,
        end: end > 1000 ? end / 1000 : end,
        text,
        confidence: 'high',
      },
    ];
  });
}

function findCaptionEvents(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of ['events', 'cues', 'segments']) {
    if (Array.isArray(record[key])) return record[key].filter(isRecord);
  }
  return [];
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(',', '.');
  const parts = cleaned.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts.length === 1 && Number.isFinite(parts[0]) ? parts[0] : undefined;
}

function parseVttSettings(value?: string): CaptionCue['settings'] {
  if (!value) return undefined;
  const settings: NonNullable<CaptionCue['settings']> = {};
  value.split(/\s+/).forEach((item) => {
    const [key, setting] = item.split(':', 2);
    if (key === 'line') settings.line = setting;
    else if (key === 'position') settings.position = setting;
    else if (key === 'size') settings.size = setting;
    else if (key === 'align') settings.align = setting;
    else if (key === 'vertical') settings.vertical = setting;
  });
  return settings;
}

function readAttribute(attributes: string, name: string): string | undefined {
  return attributes.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
}

function stripTags(value: string): string {
  return value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function formatWebVttTime(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const milliseconds = Math.round((safeSeconds - Math.floor(safeSeconds)) * 1000);
  const normalizedMilliseconds = milliseconds === 1000 ? 0 : milliseconds;
  const normalizedWholeSeconds = milliseconds === 1000 ? wholeSeconds + 1 : wholeSeconds;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(
    normalizedWholeSeconds,
  ).padStart(2, '0')}.${String(normalizedMilliseconds).padStart(3, '0')}`;
}
