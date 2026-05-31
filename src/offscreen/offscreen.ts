// Offscreen document = the OCR engine host. It's a real DOM page that is
// cross-origin isolated (COOP/COEP) and WebGPU-capable, so we run the engine
// (ppu-paddle-ocr / PP-OCRv5) here directly — no separate worker for v1.

import { recognizeBuffer } from './engine'
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
    // TODO(super-res): for low-res video frames, upscale the crop before
    //   recognition (biggest quality lever for the code-from-video case).
    const imageBuffer = await (await fetch(req.imageDataUrl)).arrayBuffer()

    post({ type: 'OCR_STATUS', stage: 'recognizing' })
    const out = await recognizeBuffer(imageBuffer)

    post({ type: 'OCR_STATUS', stage: 'done' })
    post({
      type: 'OCR_RESULT',
      text: out.text,
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
