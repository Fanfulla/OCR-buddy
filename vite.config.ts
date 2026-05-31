import { defineConfig, type Plugin } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import manifest from './src/manifest.config'

// Self-host the ONNX Runtime Web wasm + loaders into dist/ort/ (flat). MV3 CSP
// blocks ORT's default CDN fetch; offscreen.ts sets ort.env.wasm.wasmPaths to
// chrome.runtime.getURL('ort/'). We ship only the CPU-threaded build and the
// .jsep build (WebGPU/WebNN) — the variants ORT actually loads.
function copyOrtWasm(): Plugin {
  const files = [
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.jsep.mjs',
  ]
  return {
    name: 'copy-ort-wasm',
    apply: 'build',
    closeBundle() {
      const src = join(process.cwd(), 'node_modules/onnxruntime-web/dist')
      const dest = join(process.cwd(), 'dist/ort')
      mkdirSync(dest, { recursive: true })
      for (const f of files) copyFileSync(join(src, f), join(dest, f))
    },
  }
}

// CRXJS wires up MV3: builds the service worker, offscreen doc, side panel,
// content script, and auto-manages web_accessible_resources / HMR.
export default defineConfig({
  plugins: [crx({ manifest }), copyOrtWasm()],
  build: {
    target: 'esnext', // top-level await + modern WASM/WebGPU
    rollupOptions: {
      // offscreen.html isn't a standard manifest field CRXJS scans, so declare
      // it as an HTML entry. Vite then bundles offscreen.ts (which hosts the
      // OCR engine).
      input: {
        offscreen: 'src/offscreen/offscreen.html',
      },
    },
  },
  // Ensure a single onnxruntime-web instance so our ort.env mutations affect the
  // same singleton ppu-paddle-ocr uses.
  resolve: { dedupe: ['onnxruntime-web'] },
  // onnxruntime-web ships large prebuilt .wasm/.mjs; let Vite serve them as-is.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  server: { port: 5173, strictPort: true },
})
