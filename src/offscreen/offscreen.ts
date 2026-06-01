// Offscreen document = the OCR engine host. It's a real DOM page that is
// cross-origin isolated (COOP/COEP) and WebGPU-capable, so we run the engine
// (ppu-paddle-ocr / PP-OCRv5) here directly — no separate worker for v1.

import { recognizeBuffer, recognizeFormulaImage, recognizeTableImage } from './engine'
import type { Message, OcrResult, OcrStatus, RunOcr } from '../shared/messages'

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

    if (req.mode === 'table') {
      post({ type: 'OCR_STATUS', stage: 'recognizing' })
      const tbl = await recognizeTableImage(imageBuffer)
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
    const out = await recognizeBuffer(imageBuffer)

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

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type === 'RUN_OCR') void run(msg)
  return false
})
