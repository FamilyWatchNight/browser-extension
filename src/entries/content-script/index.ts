import type { ActionResponse, ContentScriptMessage, ScreenshotResponse, VideoElement } from '../../shared/messages'
import { findAllVideos } from '../../shared/utils/dom-query'
import { createVideoElementSnapshot } from '../../shared/utils/video-element'

const detectedVideos: Map<string, HTMLVideoElement> = new Map()

// Initialize on page load
function initializeContentScript() {
  console.log('[Content Script] Initializing...')
  
  const videos = findAllVideos()
  console.log(`[Content Script] Found ${videos.length} video elements`)

  // Create snapshots and listen for updates
  videos.forEach((video) => {
    const snapshot = createVideoElementSnapshot(video, 0)
    detectedVideos.set(snapshot.id, video)
  })

  // Listen for messages from service worker
  chrome.runtime.onMessage.addListener((message: ContentScriptMessage, _sender, sendResponse) => {
    console.log('[Content Script] Received message:', message.type)

    switch (message.type) {
      case 'GET_VIDEO_ELEMENTS':
        handleGetVideoElements(sendResponse)
        return true

      case 'PLAY_VIDEO':
        handlePlayVideo(message.videoId, sendResponse)
        return true

      case 'PAUSE_VIDEO':
        handlePauseVideo(message.videoId, sendResponse)
        return true

      case 'MOVE_PLAYHEAD':
        handleMovePlayhead(message.videoId, message.seekTime, sendResponse)
        return true

      case 'CAPTURE_SCREENSHOT':
        handleCaptureScreenshot(message.videoId, sendResponse)
        return true

      default:
        sendResponse({ success: false, error: 'Unknown message type' })
    }
  })
}

function handleGetVideoElements(sendResponse: (data: VideoElement[]) => void) {
  const snapshots = Array.from(detectedVideos.entries()).map(([id, video]) => ({
    id,
    src: video.src || video.currentSrc,
    title: document.title,
    duration: video.duration,
    currentTime: video.currentTime,
    paused: video.paused,
    frameIndex: 0,
  }))
  sendResponse(snapshots)
}

function handlePlayVideo(videoId: string, sendResponse: (data: ActionResponse) => void) {
  const video = detectedVideos.get(videoId)
  if (video) {
    video.play().catch(e => console.error('Play failed:', e))
    sendResponse({ success: true })
  } else {
    sendResponse({ success: false, error: 'Video not found' })
  }
}

function handlePauseVideo(videoId: string, sendResponse: (data: ActionResponse) => void) {
  const video = detectedVideos.get(videoId)
  if (video) {
    video.pause()
    sendResponse({ success: true })
  } else {
    sendResponse({ success: false, error: 'Video not found' })
  }
}

function handleMovePlayhead(videoId: string, seekTime: number, sendResponse: (data: ActionResponse) => void) {
  const video = detectedVideos.get(videoId)
  if (video) {
    video.currentTime = seekTime
    sendResponse({ success: true })
  } else {
    sendResponse({ success: false, error: 'Video not found' })
  }
}

function handleCaptureScreenshot(videoId: string, sendResponse: (data: ScreenshotResponse) => void) {
  const video = detectedVideos.get(videoId)
  if (!video) {
    sendResponse({ success: false, error: 'Video not found' })
    return
  }

  try {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      sendResponse({ success: false, error: 'Cannot get canvas context' })
      return
    }

    ctx.drawImage(video, 0, 0)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9)
    sendResponse({ success: true, data: dataUrl })
  } catch (e) {
    console.error('Screenshot failed:', e)
    sendResponse({ success: false, error: String(e) })
  }
}

// Start initialization
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeContentScript)
} else {
  initializeContentScript()
}
