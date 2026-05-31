// The OCR engine, shared by the offscreen document (production path) and the
// testbed page (automated verification). Wraps ppu-paddle-ocr (PP-OCRv5, faithful
// CTC) on ONNX Runtime Web, with bundled models and self-hosted wasm.

import * as ort from 'onnxruntime-web'
import { PaddleOcrService, isWebGpuAvailable } from 'ppu-paddle-ocr/web'
import type { OcrWord } from '../shared/messages'

// Point ORT at the self-hosted wasm/loaders before any session is created.
ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/')
// Multi-threaded WASM needs SharedArrayBuffer, available because the host page is
// cross-origin isolated (COOP/COEP). The WebGPU path ignores this.
ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4

const MODELS = {
  detection: 'models/PP-OCRv5_mobile_det_infer.onnx',
  recognition: 'models/latin_PP-OCRv5_mobile_rec_infer.onnx',
  charactersDictionary: 'models/ppocrv5_latin_dict.txt',
}

export interface OcrOutput {
  text: string
  words: OcrWord[]
  backend: 'webgpu' | 'wasm'
  empty: boolean
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
    // executionProviders are auto-resolved by the service (WebGPU → WASM).
  })
  await service.initialize()
  return service
}

/** Run detection + recognition on encoded image bytes (e.g. a PNG ArrayBuffer). */
export async function recognizeBuffer(imageBuffer: ArrayBuffer): Promise<OcrOutput> {
  const svc = await getService()
  const res = await svc.recognize(imageBuffer, { flatten: true })
  const words: OcrWord[] = res.results.map((r) => ({
    text: r.text,
    confidence: r.confidence,
    box: r.box, // ppu-paddle-ocr Box is already {x,y,width,height}
  }))
  return { text: res.text, words, backend, empty: words.length === 0 }
}
