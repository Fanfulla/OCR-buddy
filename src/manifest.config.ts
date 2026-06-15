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
  version: '2.5.5',
  description:
    'Faithful, fully-local OCR. Select a region, get the text — no server, no hallucinations.',
  minimum_chrome_version: '124',

  action: {
    default_title: 'OCR Buddy — open panel, then Select region',
    default_icon: { '16': 'icons/icon16.png', '32': 'icons/icon32.png' },
  },

  commands: {
    'start-capture': {
      // Ctrl+Shift+O is reserved by Chrome (Bookmark Manager); Y is free.
      suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
      description: 'OCR Buddy: start region selection',
    },
  },

  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },

  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },

  // No declared content script: a `matches: <all_urls>` declaration triggers the
  // "read and change all your data on all websites" install warning — poison for
  // a privacy-first extension. The selection overlay is injected on demand by the
  // service worker (chrome.scripting + activeTab / granted host), built as a
  // fixed-name classic script entry in vite.config.ts (content/overlay.js).
  permissions: [
    'activeTab', // captureVisibleTab on the tab where invoked
    'scripting', // inject the selection overlay on demand (tabs missing it)
    'offscreen', // host the warm model + worker off the service worker
    'sidePanel', // durable result UI
    'storage', // small settings
    'unlimitedStorage', // cached model files (Cache Storage)
    'contextMenus', // "OCR this image" on right-click (no install warning)
  ],

  // Not requested at install. Asked at runtime, per-site, when the user tries to
  // capture a tab they didn't invoke on — so capture works across tabs without a
  // blanket grant. The screenshot (the sensitive action) is gated per origin.
  optional_host_permissions: ['<all_urls>'],

  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },

  // Cross-origin isolation for the WASM-threads fallback (applies to extension
  // pages, incl. the offscreen document). See `crossOriginIsolation` above.
  ...crossOriginIsolation,

  web_accessible_resources: [
    {
      // offscreen page, self-hosted ORT wasm/loaders, bundled OCR models, and the
      // dev testbed page + its sample image.
      resources: [
        'src/offscreen/offscreen.html',
        'src/testbed/testbed.html',
        'ort/*',
        'models/*',
        'test/*',
      ],
      matches: ['<all_urls>'],
    },
  ],

  icons: {
    '16': 'icons/icon16.png',
    '32': 'icons/icon32.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png',
  },
})
