import type { VideoElement, VideoPlaybackUpdate } from '../messages';

export function createVideoElementSnapshot(
  video: HTMLVideoElement,
  frameIndex: number = 0,
): VideoElement {
  const rect = video.getBoundingClientRect();
  const styles = getComputedStyle(video);
  const src = video.src || video.currentSrc || video.querySelector('source')?.src || '';
  const width = toFiniteDimension(rect.width);
  const height = toFiniteDimension(rect.height);

  return {
    id: `video-${Date.now()}-${Math.random()}`,
    src,
    title: getVideoTitle(video),
    duration: video.duration || 0,
    currentTime: video.currentTime || 0,
    paused: video.paused,
    playbackRate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
    seeking: video.seeking,
    buffering: !video.paused && video.readyState < 3,
    frameIndex,
    width,
    height,
    isVisible:
      width > 0 &&
      height > 0 &&
      styles.display !== 'none' &&
      styles.visibility !== 'hidden' &&
      styles.opacity !== '0',
    hasSource: Boolean(src || video.srcObject),
    readyState: video.readyState,
  };
}

function toFiniteDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function getVideoTitle(video: HTMLVideoElement): string {
  return video.title || document.title || 'Unknown Video';
}

export function setupVideoListeners(
  video: HTMLVideoElement,
  onUpdate: (state: VideoPlaybackUpdate) => void,
): () => void {
  const updateState = () => {
    onUpdate({
      currentTime: video.currentTime,
      paused: video.paused,
      duration: video.duration,
      playbackRate: video.playbackRate,
    });
  };

  const eventNames = [
    'play',
    'playing',
    'pause',
    'timeupdate',
    'loadedmetadata',
    'durationchange',
    'seeking',
    'seeked',
    'waiting',
    'ended',
    'ratechange',
    'emptied',
    'loadstart',
  ];
  eventNames.forEach((name) => video.addEventListener(name, updateState));

  return () => {
    eventNames.forEach((name) => video.removeEventListener(name, updateState));
  };
}
