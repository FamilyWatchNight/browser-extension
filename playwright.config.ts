import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './src/test/browser',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
  },
  webServer: [
    {
      command: 'node scripts/browser-fixture-server.mjs',
      url: 'http://127.0.0.1:4173/initial',
      reuseExistingServer: false,
      env: { PORT: '4173', CROSS_ORIGIN_PORT: '4174' },
    },
    {
      command: 'node scripts/browser-fixture-server.mjs',
      url: 'http://127.0.0.1:4174/initial',
      reuseExistingServer: false,
      env: { PORT: '4174', CROSS_ORIGIN_PORT: '4173' },
    },
  ],
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
})
