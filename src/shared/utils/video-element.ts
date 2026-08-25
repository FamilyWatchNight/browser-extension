import type { VideoElement, VideoPlaybackUpdate } from '../messages'

export function createVideoElementSnapshot(video: HTMLVideoElement, frameIndex: number = 0): VideoElement {
  return {
    id: `video-${Date.now()}-${Math.random()}`,
    src: video.src || video.currentSrc || video.querySelector('source')?.src || '',
    title: getVideoTitle(video),
    duration: video.duration || 0,
    currentTime: video.currentTime || 0,
    paused: video.paused,
    frameIndex,
  }
}

function getVideoTitle(video: HTMLVideoElement): string {
  return video.title || document.title || 'Unknown Video'
}

export function setupVideoListeners(
  video: HTMLVideoElement,
  onUpdate: (state: VideoPlaybackUpdate) => void
): () => void {
  const updateState = () => {
    onUpdate({
      currentTime: video.currentTime,
      paused: video.paused,
      duration: video.duration,
    })
  }

  video.addEventListener('play', updateState)
  video.addEventListener('pause', updateState)
  video.addEventListener('timeupdate', updateState)
  video.addEventListener('loadedmetadata', updateState)

  return () => {
    video.removeEventListener('play', updateState)
    video.removeEventListener('pause', updateState)
    video.removeEventListener('timeupdate', updateState)
    video.removeEventListener('loadedmetadata', updateState)
  }
}
