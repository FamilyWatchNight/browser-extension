import type { ExtensionSettings } from '../messages'

export interface StorageSchema {
  settings: ExtensionSettings
  isEnabled: boolean
}

export function isExtensionSettings(value: unknown): value is ExtensionSettings {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const settings = value as Partial<ExtensionSettings>
  return (
    typeof settings.isEnabled === 'boolean' &&
    typeof settings.screenshotSaveLocation === 'string'
  )
}