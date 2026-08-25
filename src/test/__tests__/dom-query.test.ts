import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findAllVideos } from '../../shared/utils/dom-query'

describe('dom-query', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  it('finds direct video elements', () => {
    container.innerHTML = '<video src="test.mp4"></video>'
    const videos = findAllVideos(container)
    expect(videos).toHaveLength(1)
  })

  it('finds multiple video elements', () => {
    container.innerHTML = `
      <video src="video1.mp4"></video>
      <video src="video2.mp4"></video>
    `
    const videos = findAllVideos(container)
    expect(videos).toHaveLength(2)
  })

  it('returns empty array when no videos found', () => {
    container.innerHTML = '<p>No videos here</p>'
    const videos = findAllVideos(container)
    expect(videos).toHaveLength(0)
  })

  it('finds videos with source child elements', () => {
    container.innerHTML = `
      <video>
        <source src="test.mp4" type="video/mp4" />
      </video>
    `
    const videos = findAllVideos(container)
    expect(videos).toHaveLength(1)
  })
})