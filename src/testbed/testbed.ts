// Verification harness: runs the production engine on a bundled test image inside
// the real extension origin (so CSP, COOP/COEP, getURL paths, self-hosted wasm and
// the bundled models are all exercised). Output goes to #out for Playwright to read.

import { recognizeBuffer } from '../offscreen/engine'

const out = document.getElementById('out') as HTMLPreElement
const log = (s: string) => {
  out.textContent += s + '\n'
}

async function main() {
  try {
    log('crossOriginIsolated=' + crossOriginIsolated)
    log('webgpu=' + Boolean((navigator as unknown as { gpu?: unknown }).gpu))
    const buf = await (await fetch(chrome.runtime.getURL('test/sample.png'))).arrayBuffer()
    log('imageBytes=' + buf.byteLength)

    const t0 = performance.now()
    const res = await recognizeBuffer(buf)
    log('ms=' + Math.round(performance.now() - t0))
    log('backend=' + res.backend)
    log('empty=' + res.empty)
    log('words=' + res.words.length)
    log('TEXT>>>' + JSON.stringify(res.text))
    document.body.dataset.done = 'ok'
  } catch (e) {
    log('ERROR: ' + (e instanceof Error ? (e.stack ?? e.message) : String(e)))
    document.body.dataset.done = 'err'
  }
}

void main()
