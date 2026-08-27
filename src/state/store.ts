import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

import type { ExtensionSettings, ExtensionState, VideoElement } from '../shared/messages'
import { isExtensionSettings } from '../shared/storage/schema'

const defaultSettings: ExtensionSettings = {
  isEnabled: true,
}

const defaultState: ExtensionState = {
  isEnabled: true,
  videos: [],
  playbackState: {},
  settings: defaultSettings,
}

interface ExtensionStore extends ExtensionState {
  setSettings: (settings: ExtensionSettings) => void
  setVideos: (videos: VideoElement[]) => void
  updatePlaybackState: (videoId: string, position: number, isPlaying: boolean) => void
  setEnabled: (isEnabled: boolean) => void
  loadFromStorage: () => Promise<void>
}

export const useExtensionStore = create<ExtensionStore>()(
  subscribeWithSelector((set) => ({
    ...defaultState,

    // Settings
    setSettings: (settings: ExtensionSettings) => {
      set({ settings })
      // Sync to chrome.storage.sync
      chrome.storage.sync.set({ settings })
    },

    // Videos
    setVideos: (videos: VideoElement[]) => set({ videos }),

    // Playback state
    updatePlaybackState: (videoId: string, position: number, isPlaying: boolean) => {
      set(state => ({
        playbackState: {
          ...state.playbackState,
          [videoId]: { position, isPlaying },
        },
      }))
    },

    // Enable/disable
    setEnabled: (isEnabled: boolean) => {
      set({ isEnabled })
      chrome.storage.sync.set({ isEnabled })
    },

    // Initialize from storage
    loadFromStorage: async () => {
      const result = await chrome.storage.sync.get(['settings', 'isEnabled'])
      const settings = isExtensionSettings(result.settings) ? result.settings : defaultSettings
      const isEnabled = typeof result.isEnabled === 'boolean' ? result.isEnabled : true
      set({ settings, isEnabled })
    },
  }))
)

// Listen to storage changes across contexts
if (typeof chrome !== 'undefined' && chrome.storage) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') {
      if (changes.settings) {
        if (isExtensionSettings(changes.settings.newValue)) {
          useExtensionStore.setState({ settings: changes.settings.newValue })
        }
      }
      if (changes.isEnabled && typeof changes.isEnabled.newValue === 'boolean') {
        useExtensionStore.setState({ isEnabled: changes.isEnabled.newValue })
      }
    }
  })
}
