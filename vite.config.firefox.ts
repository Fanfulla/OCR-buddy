import { copyFileSync, cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

const OUT_DIR = 'dist-firefox'

const manifest = {
  manifest_version: 3,
  name: 'OCR Buddy',
  version: '2.6.1',
  description: 'Faithful, fully-local OCR. Select a region, get the text — no server, no hallucinations.',
  browser_specific_settings: {
    gecko: {
      id: 'ocr-buddy@fanfulla.github.io',
      strict_min_version: '142.0',
      data_collection_permissions: { required: ['none'] },
    },
  },
  action: {
    default_title: 'OCR Buddy — open sidebar',
    default_icon: { '16': 'icons/icon16.png', '32': 'icons/icon32.png' },
  },
  sidebar_action: {
    default_title: 'OCR Buddy',
    default_panel: 'src/sidepanel/index.html',
    open_at_install: false,
  },
  background: {
    scripts: ['background/service-worker.js'],
    type: 'module',
  },
  commands: {
    'start-capture': {
      suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
      description: 'OCR Buddy: start region selection',
    },
    'capture-viewport': { description: 'OCR Buddy: capture visible page' },
    'capture-fullpage': { description: 'OCR Buddy: capture full page (Text/Code)' },
  },
  permissions: ['activeTab', 'scripting', 'storage', 'unlimitedStorage', 'contextMenus'],
  optional_host_permissions: ['<all_urls>'],
  optional_permissions: ['clipboardWrite'],
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  icons: {
    '16': 'icons/icon16.png',
    '32': 'icons/icon32.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png',
  },
}

function firefoxSidepanelEntry(): Plugin {
  return {
    name: 'firefox-sidepanel-entry',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        if (!context.filename.replaceAll('\\', '/').endsWith('src/sidepanel/index.html')) return html
        return html.replace('src="./sidepanel.ts"', 'src="./firefox.ts"')
      },
    },
  }
}

function firefoxManifest(): Plugin {
  return {
    name: 'firefox-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(manifest, null, 2),
      })
    },
  }
}

function copyPackagedAssets(): Plugin {
  return {
    name: 'copy-firefox-assets',
    apply: 'build',
    closeBundle() {
      const root = process.cwd()
      const out = join(root, OUT_DIR)
      const ortSource = join(root, 'node_modules/onnxruntime-web/dist')
      const ortDest = join(out, 'ort')
      mkdirSync(ortDest, { recursive: true })
      for (const file of [
        'ort-wasm-simd-threaded.wasm',
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.jsep.wasm',
        'ort-wasm-simd-threaded.jsep.mjs',
      ]) copyFileSync(join(ortSource, file), join(ortDest, file))

      const pdfSource = join(root, 'node_modules/pdfjs-dist')
      const pdfDest = join(out, 'pdfjs')
      mkdirSync(pdfDest, { recursive: true })
      copyFileSync(join(pdfSource, 'legacy/build/pdf.worker.min.mjs'), join(pdfDest, 'pdf.worker.min.mjs'))
      for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        cpSync(join(pdfSource, directory), join(pdfDest, directory), { recursive: true })
      }
      copyFileSync(join(pdfSource, 'LICENSE'), join(pdfDest, 'LICENSE'))
      cpSync(join(root, 'icons'), join(out, 'icons'), { recursive: true })
      copyFileSync(join(root, 'site/changelog.html'), join(out, 'updates.html'))
    },
  }
}

export default defineConfig({
  define: { __FIREFOX_BUILD__: 'true' },
  plugins: [firefoxSidepanelEntry(), firefoxManifest(), copyPackagedAssets()],
  build: {
    target: 'esnext',
    outDir: OUT_DIR,
    rollupOptions: {
      input: {
        'src/sidepanel/index': 'src/sidepanel/index.html',
        'src/offscreen/offscreen': 'src/offscreen/offscreen.html',
        'src/testbed/testbed': 'src/testbed/testbed.html',
        'service-worker': 'src/background/service-worker.ts',
        overlay: 'src/content/overlay.ts',
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'service-worker') return 'background/service-worker.js'
          if (chunk.name === 'overlay') return 'content/overlay.js'
          return 'assets/[name]-[hash].js'
        },
      },
    },
  },
  resolve: { dedupe: ['onnxruntime-web'] },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
})