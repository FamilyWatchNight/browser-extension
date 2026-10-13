import { describe, expect, it } from 'vitest';

import {
  isWorthReadingCaptionResponse,
  validateCaptionPayload,
} from '../../shared/utils/caption-validation';

describe('caption response validation', () => {
  it.each([
    [
      'SRT',
      'text/plain',
      '1\n00:00:01,000 --> 00:00:02,000\nA caption cue',
      'srt',
    ],
    [
      'WebVTT',
      'text/vtt',
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA caption cue',
      'webvtt',
    ],
    [
      'TTML',
      'application/ttml+xml',
      '<tt><body><div><p begin="00:00:01.000" end="00:00:02.000">A caption cue</p></div></body></tt>',
      'ttml',
    ],
    [
      'timed-event JSON',
      'application/json',
      '{"events":[{"tStartMs":1000,"dDurationMs":1000,"segs":[{"utf8":"A caption cue"}]}]}',
      'json',
    ],
  ])('accepts valid %s bodies', (_name, contentType, body, format) => {
    expect(validateCaptionPayload('https://example.com/captions', contentType, body)).toBe(format);
  });

  it('rejects JSON metadata without timed text', () => {
    expect(
      validateCaptionPayload(
        'data:application/json;base64,eyJ0aXRsZSI6Im1ldGFkYXRhIn0=',
        'application/json',
        '{"title":"metadata","description":"player configuration"}',
      ),
    ).toBeUndefined();
  });

  it('rejects known binary MIME types even if a URL resembles a caption file', () => {
    expect(
      validateCaptionPayload(
        'https://example.com/subtitles.srt',
        'application/font-woff2; charset=binary',
        '1\n00:00:01,000 --> 00:00:02,000\nNot a caption',
      ),
    ).toBeUndefined();
    expect(
      isWorthReadingCaptionResponse(
        'data:application/font-woff2;base64,abc',
        'application/font-woff2; charset=binary',
        'XHR',
      ),
    ).toBe(false);
  });

  it('requires usable timed cues and does not accept caption-like URL hints alone', () => {
    expect(
      validateCaptionPayload('https://example.com/subtitles.srt', 'text/plain', 'not a subtitle'),
    ).toBeUndefined();
    expect(
      validateCaptionPayload('https://example.com/subtitles.vtt', 'text/vtt', 'WEBVTT'),
    ).toBeUndefined();
  });
});
