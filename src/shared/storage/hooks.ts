import { useEffect, useState } from 'react'

export function useStorage<K extends string, V>(key: K, defaultValue: V): [V, (value: V) => void] {
  const [value, setValue] = useState<V>(defaultValue)

  useEffect(() => {
    // Load initial value
    chrome.storage.sync.get([key], result => {
      const storedValue = result[key] as V | undefined
      if (storedValue !== undefined) {
        setValue(storedValue)
      }
    })

    // Subscribe to changes
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      const change = changes[key]
      if (change && change.newValue !== undefined) {
        setValue(change.newValue as V)
      }
    }
    chrome.storage.onChanged.addListener(listener)

    return () => chrome.storage.onChanged.removeListener(listener)
  }, [key])

  const setSyncedValue = (newValue: V) => {
    setValue(newValue)
    chrome.storage.sync.set({ [key]: newValue })
  }

  return [value, setSyncedValue]
}
