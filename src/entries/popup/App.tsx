import { useEffect, useState } from 'react'

import type { VideoElement } from '../../shared/messages'
import { connectToServiceWorker } from '../../shared/utils/extension-api'
import { useExtensionStore } from '../../state/store'

export default function PopupApp() {
  const { isEnabled, setEnabled } = useExtensionStore()
  const [localVideos, setLocalVideos] = useState<VideoElement[]>([])
  const [, setPort] = useState<chrome.runtime.Port | null>(null)

  useEffect(() => {
    // Connect to service worker
    const newPort = connectToServiceWorker('popup-port')
    setPort(newPort)

    newPort.postMessage({ type: 'REQUEST_STATE' })
    newPort.onMessage.addListener(message => {
      if (message.type === 'STATE_UPDATED') {
        setLocalVideos(message.state.videos)
      }
    })

    // Fetch video elements from active tab
    fetchVideoElements()

    return () => newPort.disconnect()
  }, [])

  async function fetchVideoElements() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab.id) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_ELEMENTS' })
        setLocalVideos(response || [])
      } catch (e) {
        console.error('Failed to fetch videos:', e)
      }
    }
  }

  async function controlVideo(action: 'play' | 'pause' | 'skip') {
    if (localVideos.length === 0) return

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab.id) return

    const videoId = localVideos[0].id

    try {
      if (action === 'play') {
        await chrome.tabs.sendMessage(tab.id, { type: 'PLAY_VIDEO', videoId })
      } else if (action === 'pause') {
        await chrome.tabs.sendMessage(tab.id, { type: 'PAUSE_VIDEO', videoId })
      } else if (action === 'skip') {
        const currentTime = localVideos[0].currentTime + 10
        await chrome.tabs.sendMessage(tab.id, {
          type: 'MOVE_PLAYHEAD',
          videoId,
          seekTime: currentTime,
        })
      }

      // Refresh video state
      await new Promise(r => setTimeout(r, 500))
      fetchVideoElements()
    } catch (e) {
      console.error(`Failed to ${action} video:`, e)
    }
  }

  async function captureScreenshot() {
    if (localVideos.length === 0) return

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab.id) return

    const videoId = localVideos[0].id

    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'CAPTURE_SCREENSHOT',
        videoId,
      })

      if (response.success && response.data) {
        // In phase 2, add download/export logic
        console.log('Screenshot captured:', response.data.substring(0, 50) + '...')
      }
    } catch (e) {
      console.error('Failed to capture screenshot:', e)
    }
  }

  return (
    <div style={{ padding: '16px' }}>
      <h2 style={{ margin: '0 0 16px 0' }}>Virtual Remote Control</h2>

      <div style={{ marginBottom: '16px' }}>
        <label>
          <input
            type="checkbox"
            checked={isEnabled}
            onChange={e => setEnabled(e.target.checked)}
          />
          {' Enable'}
        </label>
      </div>

      {localVideos.length > 0 ? (
        <>
          <div style={{ marginBottom: '12px', fontSize: '12px', color: '#666' }}>
            Found {localVideos.length} video(s)
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <button onClick={() => controlVideo('play')} style={{ padding: '8px' }}>
              ▶ Play
            </button>
            <button onClick={() => controlVideo('pause')} style={{ padding: '8px' }}>
              ⏸ Pause
            </button>
            <button onClick={() => controlVideo('skip')} style={{ padding: '8px' }}>
              ⏩ Skip +10s
            </button>
            <button onClick={captureScreenshot} style={{ padding: '8px' }}>
              📸 Screenshot
            </button>
          </div>

          <div style={{ marginTop: '12px', fontSize: '12px' }}>
            <p>
              <strong>Note:</strong> Advanced controls via WebSocket coming in phase 2!
            </p>
          </div>
        </>
      ) : (
        <div style={{ padding: '12px', backgroundColor: '#f0f0f0', borderRadius: '4px' }}>
          No video found on this page. Try navigating to a video streaming site.
        </div>
      )}
    </div>
  )
}
