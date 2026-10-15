import type { ContentPlayheadState, VideoElement } from '../messages';

const MIN_VALID_DURATION_SECONDS = 0.1;
const DURATION_TOLERANCE_SECONDS = 5;
const DURATION_RATIO_TOLERANCE = 0.8;
const TIMELINE_REPLACEMENT_RATIO = 4;
const TIMELINE_REPLACEMENT_MIN_GROWTH_SECONDS = 120;

export function updateContentPlayhead(
  previous: ContentPlayheadState | undefined,
  videos: VideoElement[],
  observedAtMs: number,
): ContentPlayheadState | undefined {
  const candidate = selectContentCandidate(videos);
  if (!candidate) {
    if (!previous) return undefined;
    return { ...previous, observedAtMs, playing: false };
  }

  const duration = getValidDuration(candidate.duration);
  const mediaTime = getValidTime(candidate.currentTime);
  const playbackRate = getPlaybackRate(candidate.playbackRate);

  if (!previous) {
    return {
      videoId: candidate.id,
      currentTime: mediaTime,
      duration,
      observedDuration: duration,
      observedAtMs,
      playing: isActivelyPlaying(candidate),
      playbackRate,
      suspended: false,
      confidence: 'medium',
    };
  }

  if (candidate.id !== previous.videoId) {
    if (isShorterThanBaseline(duration, previous.duration)) {
      return { ...previous, observedAtMs, playing: false, suspended: true };
    }
    return {
      videoId: candidate.id,
      currentTime: mediaTime,
      duration,
      observedDuration: duration,
      observedAtMs,
      playing: isActivelyPlaying(candidate),
      playbackRate,
      suspended: false,
      confidence: 'medium',
    };
  }

  const timelineReset = mediaTime + 2 < previous.currentTime;
  const durationShrank = isShorterThanBaseline(duration, previous.duration);
  const durationGrewSubstantially =
    duration > previous.observedDuration * TIMELINE_REPLACEMENT_RATIO &&
    duration - previous.observedDuration >= TIMELINE_REPLACEMENT_MIN_GROWTH_SECONDS;
  const resumedContentTimeline =
    previous.suspended &&
    duration >= previous.duration * DURATION_RATIO_TOLERANCE &&
    durationGrewSubstantially;
  const contentDuration = resumedContentTimeline ? duration : previous.duration;
  const observedDuration = duration;
  const suspended =
    !resumedContentTimeline &&
    (durationShrank ||
      (previous.suspended && duration < previous.duration * DURATION_RATIO_TOLERANCE) ||
      (timelineReset && duration !== previous.observedDuration && !candidate.seeking));

  let currentTime = previous.currentTime;
  if (resumedContentTimeline || (!suspended && !timelineReset) || candidate.seeking) {
    currentTime = mediaTime;
  } else if (timelineReset && duration >= previous.duration * DURATION_RATIO_TOLERANCE) {
    currentTime = mediaTime;
  }

  return {
    videoId: candidate.id,
    currentTime: Math.min(currentTime, contentDuration),
    duration: contentDuration,
    observedDuration,
    observedAtMs,
    playing: isActivelyPlaying(candidate) && !suspended,
    playbackRate,
    suspended,
    confidence: resumedContentTimeline ? 'high' : previous.confidence,
  };
}

export function getInterpolatedContentTime(
  state: ContentPlayheadState | undefined,
  nowMs: number,
): number | undefined {
  if (!state) return undefined;
  if (!state.playing || state.suspended) return state.currentTime;
  const elapsedSeconds = Math.max(0, nowMs - state.observedAtMs) / 1000;
  return Math.min(state.duration, state.currentTime + elapsedSeconds * state.playbackRate);
}

export function formatPlaybackTime(seconds: number, tenths: boolean): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const scale = tenths ? 10 : 1;
  const roundedUnits = Math.round(seconds * scale);
  const wholeSeconds = Math.floor(roundedUnits / scale);
  const fractionalDigit = roundedUnits % scale;
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainderSeconds = wholeSeconds % 60;
  const time = hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainderSeconds).padStart(2, '0')}`
    : `${minutes}:${String(remainderSeconds).padStart(2, '0')}`;
  return tenths ? `${time}.${fractionalDigit}` : time;
}

function selectContentCandidate(videos: VideoElement[]): VideoElement | undefined {
  return videos
    .filter(
      (video) =>
        video.hasSource &&
        Number.isFinite(video.duration) &&
        video.duration >= MIN_VALID_DURATION_SECONDS,
    )
    .slice()
    .sort((left, right) => candidateScore(right) - candidateScore(left))[0];
}

function candidateScore(video: VideoElement): number {
  const durationScore = Math.log2(Math.max(video.duration, 1)) * 10_000;
  const visibilityScore = video.isVisible ? 100_000 : 0;
  const areaScore = Math.min(video.width * video.height, 1_000_000) / 10;
  const playingScore = video.paused ? 0 : 5_000;
  const sourceScore = video.hasSource ? 1_000 : 0;
  return durationScore + visibilityScore + areaScore + playingScore + sourceScore;
}

function isShorterThanBaseline(candidateDuration: number, baselineDuration: number): boolean {
  return (
    candidateDuration < baselineDuration * DURATION_RATIO_TOLERANCE &&
    baselineDuration - candidateDuration > DURATION_TOLERANCE_SECONDS
  );
}

function getValidDuration(value: number): number {
  return Number.isFinite(value) && value >= MIN_VALID_DURATION_SECONDS ? value : 0;
}

function getValidTime(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getPlaybackRate(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 1;
}

function isActivelyPlaying(video: VideoElement): boolean {
  return !video.paused && !video.seeking && !video.buffering;
}
