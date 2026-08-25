import { useEffect, useState } from 'react'

import type { ExtensionSettings } from '../../shared/messages'
import { isExtensionSettings } from '../../shared/storage/schema'

export default function OptionsApp() {
  const [settings, setSettings] = useState<ExtensionSettings>({
    isEnabled: true,
    screenshotSaveLocation: 'Downloads',
  })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    // Load settings from chrome.storage.sync
    chrome.storage.sync.get(['settings'], result => {
      if (isExtensionSettings(result.settings)) {
        setSettings(result.settings)
      }
    })
  }, [])

  function handleSave() {
    chrome.storage.sync.set({ settings }, () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  return (
    <div>
      <h1>Virtual Remote Control - Settings</h1>

      <div style={{ marginBottom: '16px' }}>
        <label>
          <strong>Screenshot Save Location:</strong>
          <input
            type="text"
            value={settings.screenshotSaveLocation}
            onChange={e =>
              setSettings({
                ...settings,
                screenshotSaveLocation: e.target.value,
              })
            }
            placeholder="e.g., Downloads, Desktop, or full path"
            style={{ marginLeft: '8px', padding: '4px', width: '200px' }}
          />
        </label>
        <p style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
          Folder where screenshots will be saved (relative to Downloads folder, or absolute path)
        </p>
      </div>

      <button onClick={handleSave} style={{ padding: '8px 16px', cursor: 'pointer' }}>
        Save Settings
      </button>

      {saved && <p style={{ color: 'green', marginTop: '8px' }}>Settings saved!</p>}

      <hr style={{ margin: '24px 0' }} />

      <p style={{ fontSize: '12px', color: '#666' }}>
        <strong>Note:</strong> Screenshots are saved as JPG with 90% quality.
      </p>
      <p style={{ fontSize: '12px', color: '#666' }}>
        <strong>Phase 2 Coming:</strong> WebSocket configuration, ad detection settings, and more
        controls!
      </p>
    </div>
  )
}
