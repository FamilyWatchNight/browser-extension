import { describe, expect, it } from 'vitest';

import type {
  ContentPlayheadState,
  VideoElement,
} from '../../shared/messages';
import { updateContentPlayhead } from '../../shared/utils/content-playhead';
import {
  createPlaybackAnalysisReport,
  PLAYBACK_ANALYSIS_MAX_OBSERVATIONS,
  recordPlaybackAnalysisObservation,
  type PlaybackAnalysisLedger,
} from '../../shared/utils/playback-analysis';

function video(overrides: Partial<VideoElement> = {}): VideoElement {
  return {
    id: 'private-element-id',
    src: 'https://private.example/signed-media-url?token=secret',
    title: 'Private movie title',
    duration: 3600,
    currentTime: 12,
    paused: false,
    frameIndex: 0,
    width: 1280,
    height: 720,
    isVisible: true,
    hasSource: true,
    readyState: 4,
    playbackRate: 1,
    seeking: false,
    buffering: false,
    ...overrides,
  };
}

describe('playback analysis', () => {
  it('samples repeated updates and records the current behavioral interpretation', () => {
    const firstVideo = video();
    const firstState = updateContentPlayhead(undefined, [firstVideo], 1_000);
    const first = recordPlaybackAnalysisObservation(
      undefined,
      [firstVideo],
      undefined,
      firstState,
      1_000,
    );
    const repeated = recordPlaybackAnalysisObservation(
      first,
      [video({ currentTime: 12.5 })],
      firstState,
      firstState,
      1_500,
    );

    expect(repeated.observations).toHaveLength(1);
    expect(repeated.totalObservations).toBe(2);

    const shorterVideo = video({ duration: 30, currentTime: 8 });
    const suspendedState = updateContentPlayhead(
      firstState,
      [shorterVideo],
      6_000,
    );
    const withTransition = recordPlaybackAnalysisObservation(
      repeated,
      [shorterVideo],
      firstState,
      suspendedState,
      6_000,
    );

    expect(withTransition.observations).toHaveLength(2);
    expect(withTransition.observations[1].suspended).toBe(true);
    expect(withTransition.observations[1].interpretation).toContain('not proof');
    expect(withTransition.observations[1].confidence).toBe('medium');
  });

  it('bounds retained observations', () => {
    let ledger: PlaybackAnalysisLedger | undefined;
    let previousState: ContentPlayheadState | undefined;

    for (let index = 0; index <= PLAYBACK_ANALYSIS_MAX_OBSERVATIONS + 4; index += 1) {
      const sample = video({ currentTime: index * 3 });
      const nextState = updateContentPlayhead(previousState, [sample], index * 1_000);
      ledger = recordPlaybackAnalysisObservation(
        ledger,
        [sample],
        previousState,
        nextState,
        index * 1_000,
      );
      previousState = nextState;
    }

    if (!ledger) throw new Error('Expected an analysis ledger.');
    expect(ledger.observations).toHaveLength(PLAYBACK_ANALYSIS_MAX_OBSERVATIONS);
    expect(ledger.omittedObservations).toBe(5);
  });

  it('exports useful reasoning without page identifiers, titles, or URLs', () => {
    const sample = video();
    const state = updateContentPlayhead(undefined, [sample], 10_000);
    const ledger = recordPlaybackAnalysisObservation(undefined, [sample], undefined, state, 10_000);
    const report = createPlaybackAnalysisReport(ledger, state, 10_500);

    expect(report).toContain('Playback analysis report');
    expect(report).toContain('generic video behavior');
    expect(report).toContain('Confidence: medium');
    expect(report).toContain('does not classify ads');
    expect(report).not.toContain('private-element-id');
    expect(report).not.toContain('Private movie title');
    expect(report).not.toContain('private.example');
    expect(report).not.toContain('secret');
  });

  it('creates an explicit report when no video observations exist', () => {
    const report = createPlaybackAnalysisReport(undefined, undefined, 1_000);

    expect(report).toContain('No video observations have been recorded');
    expect(report).toContain('Confidence: unknown');
    expect(report).toContain('excludes page titles and text, URLs');
  });
});
