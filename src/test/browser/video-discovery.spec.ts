import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test'

let context: BrowserContext
let serviceWorker: Worker
let profileDirectory: string

async function getVideosForPage(page: Page) {
  return serviceWorker.evaluate(async (targetUrl) => {
    const [tab] = await chrome.tabs.query({ url: targetUrl })
    if (!tab?.id) throw new Error(`No browser tab found for ${targetUrl}`)
    return chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_ELEMENTS' })
  }, page.url())
}

test.beforeAll(async () => {
  profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'family-watch-night-chrome-'))
  const extensionDirectory = path.resolve('dist')

  context = await chromium.launchPersistentContext(profileDirectory, {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  const fixturePage = await context.newPage()
  await fixturePage.goto('http://127.0.0.1:4173/initial')

  await expect
    .poll(() => context.serviceWorkers().length, {
      timeout: 10_000,
      message: `The extension service worker did not start from ${extensionDirectory}. Ensure Playwright Chromium is installed and the unpacked extension is valid.`,
    })
    .toBeGreaterThan(0)

  serviceWorker = context.serviceWorkers()[0]
})

test.afterAll(async () => {
  await context.close()
  fs.rmSync(profileDirectory, { recursive: true, force: true })
})

test('discovers a video present at page load', async ({ baseURL }) => {
  const page = await context.newPage()
  await page.goto(`${baseURL}/initial`)

  await expect.poll(async () => (await getVideosForPage(page)).length).toBe(1)

  await page.close()
})

test('discovers a video inserted after the initial scan', async ({ baseURL }) => {
  const page = await context.newPage()
  await page.goto(`${baseURL}/delayed`)

  await expect.poll(async () => (await getVideosForPage(page)).length, { timeout: 5_000 }).toBe(1)

  await page.close()
})

test('discovers same-origin iframe videos and excludes cross-origin videos', async ({ baseURL }) => {
  const page = await context.newPage()
  await page.goto(`${baseURL}/iframe`)

  await expect.poll(async () => (await getVideosForPage(page)).length, { timeout: 5_000 }).toBe(1)

  await page.close()
})
