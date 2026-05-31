import { defineManifest } from '@crxjs/vite-plugin'

// Valid MV3 keys that the CRXJS manifest type doesn't model. Spreading them in
// bypasses excess-property checks without an `as any` on the whole manifest.
const crossOriginIsolation = {
  cross_origin_embedder_policy: { value: 'require-corp' },
  cross_origin_opener_policy: { value: 'same-origin' },
}

// OCR Buddy — Manifest V3.
// Design notes (see research/OCR_BUDDY_RESEARCH.md §2):
//  - Service worker is COORDINATOR ONLY. Heavy OCR runs in the offscreen doc's worker.
//  - `wasm-unsafe-eval` is mandatory in MV3 to instantiate the ONNX Runtime WASM backend.
//  - COOP/COEP make the offscreen document cross-origin isolated → enables
//    SharedArrayBuffer + multi-threaded WASM (our WebGPU fallback). WebGPU itself
//    needs no isolation, so the primary path is unaffected by these keys.
//  - `activeTab` (not <all_urls>) — the overlay is injected only on user action.
export default defineManifest({
  manifest_version: 3,
  name: 'OCR Buddy',
  version: '0.1.0',
  description:
    'Faithful, fully-local OCR. Select a region, get the text — no server, no hallucinations.',
  minimum_chrome_version: '124',

  action: {
    default_title: 'OCR Buddy — click, then drag to select a region',
  },

  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },

  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },

  // Passive selection overlay on every page: it does nothing until the service
  // worker sends SHOW_OVERLAY (on action click). Declared (not dynamically
  // injected) so CRXJS bundles it reliably.
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/overlay.ts'],
      run_at: 'document_idle',
    },
  ],

  permissions: [
    'activeTab', // captureVisibleTab on the current tab
    'offscreen', // host the warm model + worker off the service worker
    'sidePanel', // durable result UI
    'storage', // small settings
    'unlimitedStorage', // cached model files (Cache Storage)
  ],

  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },

  // Cross-origin isolation for the WASM-threads fallback (applies to extension
  // pages, incl. the offscreen document). See `crossOriginIsolation` above.
  ...crossOriginIsolation,

  web_accessible_resources: [
    {
      resources: ['src/offscreen/offscreen.html', 'models/*', '*.wasm'],
      matches: ['<all_urls>'],
    },
  ],

  icons: {
    '16': 'icons/icon16.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png',
  },
})
