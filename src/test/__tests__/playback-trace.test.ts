import { describe, expect, it } from 'vitest';

import type { PlaybackTraceEvent } from '../../shared/messages';
import {
  getPlaybackTraceEventSize,
  getPlaybackTraceLimitReason,
  PLAYBACK_TRACE_MAX_MANIFEST_BYTES,
  PLAYBACK_TRACE_MAX_BYTES,
  PLAYBACK_TRACE_MAX_EVENTS,
  redactPlaybackTraceUrl,
  sanitizePlaybackManifest,
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

  it('keeps DASH timing structure while redacting manifest resource URLs and query tokens', () => {
    const manifest = sanitizePlaybackManifest(
      `<?xml version="1.0"?>
       <MPD type="static" mediaPresentationDuration="PT10M">
         <BaseURL>https://media.example/signed/path?token=secret</BaseURL>
         <ContentProtection schemeIdUri="urn:uuid:example" cenc:default_KID="sensitive-key-id">
           <cenc:pssh>encoded-license-metadata</cenc:pssh>
           <Laurl>https://license.example/path</Laurl>
         </ContentProtection>
         <Period id="ad" start="PT20S" duration="PT30S">
           <AdaptationSet contentType="video">
             <Representation id="720p" bandwidth="1000">
               <SegmentTemplate timescale="1000" media="segment-$Number$.m4s?token=secret">
                 <SegmentTimeline><S t="20000" d="5000" r="5"/></SegmentTimeline>
               </SegmentTemplate>
             </Representation>
           </AdaptationSet>
         </Period>
       </MPD>`,
    );

    expect(manifest?.format).toBe('dash-mpd');
    expect(manifest?.text).toContain('mediaPresentationDuration="PT10M"');
    expect(manifest?.text).toContain('start="PT20S" duration="PT30S"');
    expect(manifest?.text).toContain('t="20000" d="5000" r="5"');
    expect(manifest?.text).toContain('<BaseURL>[redacted]</BaseURL>');
    expect(manifest?.text).not.toContain('ContentProtection');
    expect(manifest?.text).not.toContain('pssh');
    expect(manifest?.text).not.toContain('sensitive-key-id');
    expect(manifest?.text).not.toContain('encoded-license-metadata');
    expect(manifest?.text).not.toContain('license.example');
    expect(manifest?.text).not.toContain('media="segment-$Number$.m4s');
    expect(manifest?.text).not.toContain('secret');
    expect(manifest?.byteLength).toBe(new TextEncoder().encode(manifest?.text).byteLength);
  });

  it('sanitizes HLS playlist URIs and enforces the manifest document limit', () => {
    const manifest = sanitizePlaybackManifest(
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="https://key.example/key?token=secret"\n#EXTINF:6.0,\nhttps://cdn.example/segment.ts?token=secret\n',
    );

    expect(manifest?.format).toBe('hls');
    expect(manifest?.text).toContain('#EXT-X-TARGETDURATION:6');
    expect(manifest?.text).toContain('URI="[redacted]"');
    expect(manifest?.text).toContain('[redacted-uri]');
    expect(manifest?.text).not.toContain('secret');
    expect(
      sanitizePlaybackManifest(
        `<MPD>${'x'.repeat(PLAYBACK_TRACE_MAX_MANIFEST_BYTES - 11)}</MPD>`,
      )?.byteLength,
    ).toBe(PLAYBACK_TRACE_MAX_MANIFEST_BYTES);
    expect(
      sanitizePlaybackManifest(
        `<MPD>${'x'.repeat(PLAYBACK_TRACE_MAX_MANIFEST_BYTES - 10)}</MPD>`,
      ),
    ).toBeUndefined();
    expect(sanitizePlaybackManifest('<MPD mediaPresentationDuration="PT90S">')).toBeUndefined();
    expect(sanitizePlaybackManifest('<html><body>not a manifest</body></html>')).toBeUndefined();
    expect(sanitizePlaybackManifest('<!DOCTYPE MPD [<!ENTITY x "y">]><MPD/>')).toBeUndefined();
  });
});
