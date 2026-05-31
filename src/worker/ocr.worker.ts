// OCR worker — where inference actually runs (dedicated worker inside the
// offscreen doc). The model is loaded ONCE and reused across captures.
//
// ⚠️ SCAFFOLD STATE: the wiring is complete but the PP-OCRv5 inference is a
// stub. Each TODO below is a discrete, independent implementation task. The
// stack is locked (research §2): PP-OCRv5 (Apache-2.0, CTC, faithful) on
// ONNX Runtime Web — WebGPU primary, multi-threaded WASM fallback.

import type { OcrResult, OcrStatus, RunOcr } from '../shared/messages'

type Backend = 'webgpu' | 'wasm'

function post(msg: OcrStatus | OcrResult) {
  ;(self as unknown as Worker).postMessage(msg)
}

/** Pick WebGPU when available (no cross-origin isolation needed), else WASM. */
async function detectBackend(): Promise<Backend> {
  const gpu = (navigator as unknown as { gpu?: GPU }).gpu
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter()
      if (adapter) return 'webgpu'
    } catch {
      /* fall through to wasm */
    }
  }
  return 'wasm'
}

// ── Model lifecycle (loaded once) ───────────────────────────────────────────
let backend: Backend | null = null
let modelsReady = false

async function ensureModels(): Promise<void> {
  if (modelsReady) return
  backend ??= await detectBackend()

  // TODO(model-cache): download PP-OCRv5 det + rec ONNX (+ Latin dict) on first
  //   run into Cache Storage; reuse offline thereafter. navigator.storage.persist().
  // TODO(ort-init): configure onnxruntime-web env (self-hosted .wasm paths,
  //   wasm.numThreads, simd) and create InferenceSessions with the chosen
  //   executionProvider (['webgpu'] or ['wasm']).
  // TODO(opencv): lazy-load opencv.js for deskew/binarize used on photos/scenes.

  modelsReady = true
}

// ── The pipeline ─────────────────────────────────────────────────────────────
async function runOcr(req: RunOcr): Promise<void> {
  post({ type: 'OCR_STATUS', stage: 'loading-model' })
  await ensureModels()

  post({ type: 'OCR_STATUS', stage: 'preprocessing' })
  // TODO(super-res): v1 includes upscaling for low-res video frames before OCR
  //   (biggest quality lever for the code-from-YouTube case). Run a light SR
  //   model / Lanczos upscale here when the crop is small.
  // TODO(decode): dataURL → ImageBitmap → normalized tensor (det input size).

  post({ type: 'OCR_STATUS', stage: 'detecting' })
  // TODO(detect): DBNet text detection → list of oriented text-line boxes.

  post({ type: 'OCR_STATUS', stage: 'recognizing' })
  // TODO(recognize): per-box SVTR/CRNN CTC recognition → text + per-char/word
  //   confidence. CTC fails to blanks/garbage — NEVER fabricate. If a region is
  //   blank/ambiguous, emit empty (honest) rather than inventing text.
  // TODO(reading-order): sort boxes into reading order, join into full text.

  // --- Placeholder honest result until the pipeline above is implemented. ---
  const result: OcrResult = {
    type: 'OCR_RESULT',
    text: '',
    words: [],
    backend: backend!,
    imageDataUrl: req.imageDataUrl,
    empty: true,
  }
  post({ type: 'OCR_STATUS', stage: 'done' })
  post(result)
}

self.addEventListener('message', (e: MessageEvent<RunOcr>) => {
  if (e.data?.type === 'RUN_OCR') {
    runOcr(e.data).catch((err) => {
      post({
        type: 'OCR_STATUS',
        stage: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    })
  }
})
