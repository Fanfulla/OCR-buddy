import { defineConfig, type Plugin } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import { copyFileSync, cpSync, mkdirSync } from 'node:fs'
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
      // The website and installed extension share exactly the same release notes.
      copyFileSync(join(process.cwd(), 'site/changelog.html'), join(process.cwd(), 'dist/updates.html'))
    },
  }
}

// PDF processing stays offline, including the worker and uncommon PDF fonts/codecs.
function copyPdfAssets(): Plugin {
  return {
    name: 'copy-pdf-assets',
    apply: 'build',
    closeBundle() {
      const src = join(process.cwd(), 'node_modules/pdfjs-dist')
      const dest = join(process.cwd(), 'dist/pdfjs')
      mkdirSync(dest, { recursive: true })
      copyFileSync(join(src, 'legacy/build/pdf.worker.min.mjs'), join(dest, 'pdf.worker.min.mjs'))
      for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        cpSync(join(src, dir), join(dest, dir), { recursive: true })
      }
      copyFileSync(join(src, 'LICENSE'), join(dest, 'LICENSE'))
    },
  }
}

// CRXJS wires up MV3: builds the service worker, offscreen doc, side panel,
// content script, and auto-manages web_accessible_resources / HMR.
export default defineConfig({
  define: { __FIREFOX_BUILD__: 'false' },
  plugins: [crx({ manifest }), copyOrtWasm(), copyPdfAssets()],
  build: {
    target: 'esnext', // top-level await + modern WASM/WebGPU
    rollupOptions: {
      // offscreen.html isn't a standard manifest field CRXJS scans, so declare
      // it as an HTML entry. Vite then bundles offscreen.ts (which hosts the
      // OCR engine).
      input: {
        offscreen: 'src/offscreen/offscreen.html',
        testbed: 'src/testbed/testbed.html', // dev/verification page
        // Selection overlay: NOT a declared content script (that would cost the
        // all-sites install warning). The SW injects it on demand, which needs a
        // stable, module-free file — hence the fixed name below.
        overlay: 'src/content/overlay.ts',
      },
      output: {
        // chrome.scripting.executeScript runs files as CLASSIC scripts: the
        // overlay entry must keep a known path and contain no import statements
        // (its only import is type-only, erased at compile time).
        entryFileNames: (chunk) =>
          chunk.name === 'overlay' ? 'content/overlay.js' : 'assets/[name]-[hash].js',
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
