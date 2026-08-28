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
    });
  };

  video.addEventListener('play', updateState);
  video.addEventListener('pause', updateState);
  video.addEventListener('timeupdate', updateState);
  video.addEventListener('loadedmetadata', updateState);

  return () => {
    video.removeEventListener('play', updateState);
    video.removeEventListener('pause', updateState);
    video.removeEventListener('timeupdate', updateState);
    video.removeEventListener('loadedmetadata', updateState);
  };
}
