// Offscreen document = the OCR engine host. It's a real DOM page that is
// cross-origin isolated (COOP/COEP) and WebGPU-capable, so we run ppu-paddle-ocr
// (PP-OCRv5, faithful CTC) here directly — no separate worker for v1.
//
// Models are bundled in the extension (public/models → dist/models) and the ONNX
// Runtime Web wasm is self-hosted (dist/ort) because MV3 CSP blocks the CDN.

import * as ort from 'onnxruntime-web'
import { PaddleOcrService, isWebGpuAvailable } from 'ppu-paddle-ocr/web'
import type { Message, OcrResult, OcrStatus, OcrWord, RunOcr } from '../shared/messages'

// Point ORT at the self-hosted wasm/loaders before any session is created.
ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/')
// Multi-threaded WASM needs SharedArrayBuffer, available because the offscreen
// doc is cross-origin isolated (COOP/COEP). WebGPU path ignores this.
ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4
if (!crossOriginIsolated) {
  console.warn('[OCR Buddy] offscreen not cross-origin isolated — WASM threads disabled')
}

const MODELS = {
  detection: 'models/PP-OCRv5_mobile_det_infer.onnx',
  recognition: 'models/latin_PP-OCRv5_mobile_rec_infer.onnx',
  charactersDictionary: 'models/ppocrv5_latin_dict.txt',
}

let service: PaddleOcrService | null = null
let backend: 'webgpu' | 'wasm' = 'wasm'

const fetchBuf = async (path: string): Promise<ArrayBuffer> =>
  (await fetch(chrome.runtime.getURL(path))).arrayBuffer()

/** Build the engine once; reused across captures. */
async function getService(): Promise<PaddleOcrService> {
  if (service) return service
  const [detection, recognition, charactersDictionary] = await Promise.all([
    fetchBuf(MODELS.detection),
    fetchBuf(MODELS.recognition),
    fetchBuf(MODELS.charactersDictionary),
  ])
  backend = (await isWebGpuAvailable()) ? 'webgpu' : 'wasm'
  service = new PaddleOcrService({
    model: { detection, recognition, charactersDictionary },
    // canvas-native avoids the OpenCV.js dependency — lighter and MV3-friendly.
    processing: { engine: 'canvas-native' },
    // executionProviders are auto-resolved by the service (prefers WebGPU, falls
    // back to WASM), so we don't override them here.
  })
  await service.initialize()
  return service
}

async function run(req: RunOcr): Promise<void> {
  try {
    post({ type: 'OCR_STATUS', stage: 'loading-model' })
    const svc = await getService()

    post({ type: 'OCR_STATUS', stage: 'recognizing' })
    // TODO(super-res): for low-res video frames, upscale the crop here before
    //   recognition (biggest quality lever for the code-from-video case).
    const imageBuffer = await (await fetch(req.imageDataUrl)).arrayBuffer()
    const res = await svc.recognize(imageBuffer, { flatten: true })

    const words: OcrWord[] = res.results.map((r) => ({
      text: r.text,
      confidence: r.confidence,
      box: r.box, // ppu-paddle-ocr Box is already {x,y,width,height}
    }))

    post({ type: 'OCR_STATUS', stage: 'done' })
    const result: OcrResult = {
      type: 'OCR_RESULT',
      text: res.text,
      words,
      backend,
      imageDataUrl: req.imageDataUrl,
      empty: words.length === 0,
    }
    post(result)
  } catch (err) {
    post({
      type: 'OCR_STATUS',
      stage: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

function post(msg: OcrStatus | OcrResult): void {
  chrome.runtime.sendMessage(msg)
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type === 'RUN_OCR') void run(msg)
  return false
})
