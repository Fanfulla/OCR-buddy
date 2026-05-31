// The OCR engine, shared by the offscreen document (production path) and the
// testbed page (automated verification). Wraps ppu-paddle-ocr (PP-OCRv5, faithful
// CTC) on ONNX Runtime Web, with bundled models and self-hosted wasm.
//
// On top of recognition it adds two preprocessing/post-processing steps:
//  - smart upscaling of small crops (low-res video frames) before detection;
//  - code-view reconstruction of line breaks + indentation from box geometry.

import * as ort from 'onnxruntime-web'
import { PaddleOcrService, isWebGpuAvailable } from 'ppu-paddle-ocr/web'
import type { RecognitionResult } from 'ppu-paddle-ocr/web'
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

// Detection downscales anything whose long side exceeds this. We raise it above
// the default 640 so an upscaled small crop keeps its extra detail.
const MAX_SIDE = 1280
// Upscale small crops so their long side approaches this (helps detection see
// bigger glyphs — the lever for low-res video frames).
const UPSCALE_TARGET = 1100
const MAX_SCALE = 4

export interface OcrOutput {
  text: string
  codeText: string
  words: OcrWord[]
  backend: 'webgpu' | 'wasm'
  empty: boolean
  /** Raw line groups (for diagnostics/testbed). */
  lines: RecognitionResult[][]
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
    detection: { maxSideLength: MAX_SIDE },
    // canvas-native avoids the OpenCV.js dependency — lighter and MV3-friendly.
    processing: { engine: 'canvas-native' },
    // executionProviders are auto-resolved by the service (WebGPU → WASM).
  })
  await service.initialize()
  return service
}

/** Decode + smart-upscale small crops. Returns a canvas ready for recognition. */
async function prepareImage(imageBuffer: ArrayBuffer): Promise<OffscreenCanvas> {
  const bitmap = await createImageBitmap(new Blob([imageBuffer]))
  const longSide = Math.max(bitmap.width, bitmap.height)
  const scale = longSide < UPSCALE_TARGET ? Math.min(UPSCALE_TARGET / longSide, MAX_SCALE) : 1

  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  // NOTE: box coords below are in this (possibly upscaled) space. Indent math is
  // relative so scale cancels; divide by `scale` only if overlaying on the crop.
  return canvas
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const INDENT_SPACES = 4

/**
 * Reconstruct code from line-grouped boxes: leading indentation from each line's
 * left edge, plus intra-line spacing from horizontal gaps. Robust to the per-line
 * strategy returning a single box per line (then only indent applies).
 *
 * box.width/text.length overestimates the glyph advance (padding/anti-alias), so
 * raw indent slightly undercounts. We quantize: detect the one-level unit (the
 * smallest clear positive offset) and snap each line to whole levels × 4 spaces,
 * which recovers clean nesting. Falls back to raw char-units if no unit emerges.
 */
function reconstructCode(lines: RecognitionResult[][]): string {
  const flat = lines.flat()
  if (!flat.length) return ''

  const charW = median(flat.filter((w) => w.text.length).map((w) => w.box.width / w.text.length)) || 1
  const minLeft = Math.min(...flat.map((w) => w.box.x))

  // Per line: raw indent (in char units) + the reconstructed line text.
  const rows = lines.map((line) => {
    if (!line.length) return { raw: 0, text: '' }
    const sorted = [...line].sort((a, b) => a.box.x - b.box.x)
    const raw = (sorted[0].box.x - minLeft) / charW
    let text = sorted[0].text
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].box.x - (sorted[i - 1].box.x + sorted[i - 1].box.width)
      text += ' '.repeat(Math.max(1, Math.round(gap / charW))) + sorted[i].text
    }
    return { raw, text }
  })

  const positives = rows.map((r) => r.raw).filter((v) => v > 0.5)
  const unit = positives.length ? Math.min(...positives) : 0
  const quantize = unit > 0.5 && unit < 12 // sane one-indent width in chars

  return rows
    .map((r) => {
      const indent = quantize
        ? Math.max(0, Math.round(r.raw / unit)) * INDENT_SPACES
        : Math.max(0, Math.round(r.raw))
      return ' '.repeat(indent) + r.text
    })
    .join('\n')
}

/** Run detection + recognition on encoded image bytes (e.g. a PNG ArrayBuffer). */
export async function recognizeBuffer(imageBuffer: ArrayBuffer): Promise<OcrOutput> {
  const svc = await getService()
  const canvas = await prepareImage(imageBuffer)
  const res = await svc.recognize(canvas, { flatten: false })

  const words: OcrWord[] = res.lines.flat().map((r) => ({
    text: r.text,
    confidence: r.confidence,
    box: r.box, // ppu-paddle-ocr Box is already {x,y,width,height}
  }))

  return {
    text: res.text, // prose: lines joined by newlines
    codeText: reconstructCode(res.lines),
    words,
    backend,
    empty: words.length === 0,
    lines: res.lines,
  }
}
