import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest.config'

// CRXJS wires up MV3: builds the service worker, offscreen doc, side panel,
// content script, and auto-manages web_accessible_resources / HMR.
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: 'esnext', // top-level await + modern WASM/WebGPU
    rollupOptions: {
      // offscreen.html isn't a standard manifest field CRXJS scans, so declare
      // it as an HTML entry. Vite then bundles offscreen.ts and the worker it
      // spawns via `new Worker(new URL(...))`.
      input: {
        offscreen: 'src/offscreen/offscreen.html',
      },
    },
  },
  // onnxruntime-web ships large prebuilt .wasm/.mjs; let Vite serve them as-is.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  server: { port: 5173, strictPort: true },
})
