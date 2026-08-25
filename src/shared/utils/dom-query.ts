export function findAllVideos(root: Document | Element = document): HTMLVideoElement[] {
  const videos: HTMLVideoElement[] = []

  // Find direct video elements
  videos.push(...Array.from(root.querySelectorAll('video')))

  // Recursively search iframes (same-origin only)
  try {
    const iframes = root.querySelectorAll('iframe')
    iframes.forEach(iframe => {
      try {
        if (iframe.contentDocument) {
          videos.push(...findAllVideos(iframe.contentDocument))
        }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
        // Cross-origin iframe, skip silently
        console.debug('Skipping cross-origin iframe')
      }
    })
  } catch (e) {
    console.debug('Error searching iframes:', e)
  }

  return videos
}

export function deepQuerySelector(selector: string, root: Document | DocumentFragment | ShadowRoot = document): Element[] {
  const results: Element[] = []

  const walk = (node: Document | Element | DocumentFragment | ShadowRoot) => {
    try {
      results.push(...node.querySelectorAll(selector))
      // Check shadow DOMs
      node.querySelectorAll('*').forEach((el: Element) => {
        if (el.shadowRoot) {
          walk(el.shadowRoot)
        }
      })
    } catch (e) {
      console.debug('Error in deepQuerySelector:', e)
    }
  }

  walk(root)
  return results
}
