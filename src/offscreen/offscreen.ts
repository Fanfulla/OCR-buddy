// Offscreen document = the OCR engine host. It's a real DOM page that is
// cross-origin isolated (COOP/COEP) and WebGPU-capable, so we run the engine
// (ppu-paddle-ocr / PP-OCRv5) here directly — no separate worker for v1.

import { recognizeBuffer, recognizeFormulaImage, recognizeTableImage } from './engine'
import { mergeTiles } from '../background/merge-tiles'
import type { Message, OcrResult, OcrStatus, RunOcr, RunOcrTiles } from '../shared/messages'

if (!crossOriginIsolated) {
  console.warn('[OCR Buddy] offscreen not cross-origin isolated — WASM threads disabled')
}

function post(msg: OcrStatus | OcrResult): void {
  chrome.runtime.sendMessage(msg)
}

async function run(req: RunOcr): Promise<void> {
  try {
    post({ type: 'OCR_STATUS', stage: 'loading-model' })
    const imageBuffer = await (await fetch(req.imageDataUrl)).arrayBuffer()
    // First use of a non-bundled language pack downloads it (once, then cached);
    // stream the progress into the panel's loading bar, then hand the bar back
    // to the recognizing stage once the download completes.
    const onDownload = (p: number) =>
      post(
        p < 1
          ? { type: 'OCR_STATUS', stage: 'loading-model', progress: p }
          : { type: 'OCR_STATUS', stage: 'recognizing' },
      )

    if (req.mode === 'table') {
      post({ type: 'OCR_STATUS', stage: 'recognizing' })
      const tbl = await recognizeTableImage(imageBuffer, req.lang, onDownload)
      post({ type: 'OCR_STATUS', stage: 'done' })
      post({
        type: 'OCR_RESULT',
        mode: 'table',
        text: tbl.docText,
        codeText: tbl.docText,
        docText: tbl.docText,
        docBlocks: tbl.docBlocks,
        words: [],
        backend: tbl.backend,
        imageDataUrl: req.imageDataUrl,
        empty: tbl.empty,
      })
      return
    }

    if (req.mode === 'formula') {
      post({ type: 'OCR_STATUS', stage: 'recognizing' })
      const f = await recognizeFormulaImage(imageBuffer)
      post({ type: 'OCR_STATUS', stage: 'done' })
      post({
        type: 'OCR_RESULT',
        mode: 'formula',
        text: f.latex,
        codeText: f.latex,
        latex: f.latex,
        latexOk: f.ok,
        words: [],
        backend: f.backend,
        imageDataUrl: req.imageDataUrl,
        empty: !f.ok && !f.latex,
      })
      return
    }

    post({ type: 'OCR_STATUS', stage: 'recognizing' })
    const out = await recognizeBuffer(imageBuffer, req.lang, onDownload)

    post({ type: 'OCR_STATUS', stage: 'done' })
    post({
      type: 'OCR_RESULT',
      mode: 'quick',
      text: out.text,
      codeText: out.codeText,
      words: out.words,
      backend: out.backend,
      imageDataUrl: req.imageDataUrl,
      empty: out.empty,
    })
  } catch (err) {
    post({
      type: 'OCR_STATUS',
      stage: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

async function runTiles(req: RunOcrTiles): Promise<void> {
  try {
    post({ type: 'OCR_STATUS', stage: 'loading-model' })
    const n = req.imageDataUrls.length
    const texts: string[] = []
    let backend: 'webgpu' | 'wasm' = 'wasm'
    for (let i = 0; i < n; i++) {
      post({ type: 'OCR_STATUS', stage: 'recognizing', progress: n ? i / n : 0 })
      const buf = await (await fetch(req.imageDataUrls[i])).arrayBuffer()
      const onDownload = i === 0
        ? (p: number) =>
            post(
              p < 1
                ? { type: 'OCR_STATUS', stage: 'loading-model', progress: p }
                : { type: 'OCR_STATUS', stage: 'recognizing' },
            )
        : undefined
      const out = await recognizeBuffer(buf, req.lang, onDownload)
      texts.push(out.text)
      backend = out.backend // all tiles share the same session backend
    }
    const merged = mergeTiles(texts)
    post({ type: 'OCR_STATUS', stage: 'done' })
    post({
      type: 'OCR_RESULT',
      mode: 'quick',
      text: merged,
      codeText: merged, // no cross-tile code geometry; prose serves both views
      words: [], // merged from independent tiles — no global word boxes
      backend,
      imageDataUrl: req.imageDataUrls[0] ?? '', // panel source preview shows the first tile (top of page); no stitched full-page image exists
      empty: merged.trim() === '',
      note: req.truncated === true
        ? 'Full page was long — capture stopped at the tile limit; the bottom may be missing.'
        : undefined,
    })
  } catch (err) {
    post({
      type: 'OCR_STATUS',
      stage: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type === 'RUN_OCR') void run(msg)
  else if (msg.type === 'RUN_OCR_TILES') void runTiles(msg)
  return false
})
