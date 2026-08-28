import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import manifest from './src/manifest.json';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  base: '/',
  build: {
    rollupOptions: {
      input: {
        offscreen: 'src/entries/offscreen/index.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
