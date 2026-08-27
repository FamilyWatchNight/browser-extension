import { beforeEach, describe, expect, it } from 'vitest'

import type { ExtensionSettings } from '../../shared/messages'
import { useExtensionStore } from '../../state/store'

describe('useExtensionStore', () => {
  beforeEach(() => {
    // Reset store state
    useExtensionStore.setState({
      isEnabled: true,
      videos: [],
      playbackState: {},
      settings: {
        isEnabled: true,
      },
    })
  })

  it('initializes with default state', () => {
    const state = useExtensionStore.getState()
    expect(state.isEnabled).toBe(true)
    expect(state.videos).toEqual([])
  })

  it('updates settings', () => {
    const newSettings: ExtensionSettings = { isEnabled: false }
    useExtensionStore.getState().setSettings(newSettings)
    const state = useExtensionStore.getState()
    expect(state.settings.isEnabled).toBe(false)
  })

  it('toggles enabled state', () => {
    useExtensionStore.getState().setEnabled(false)
    expect(useExtensionStore.getState().isEnabled).toBe(false)

    useExtensionStore.getState().setEnabled(true)
    expect(useExtensionStore.getState().isEnabled).toBe(true)
  })

  it('updates playback state', () => {
    useExtensionStore.getState().updatePlaybackState('video-1', 30.5, true)
    const state = useExtensionStore.getState()
    expect(state.playbackState['video-1']).toEqual({ position: 30.5, isPlaying: true })
  })
})