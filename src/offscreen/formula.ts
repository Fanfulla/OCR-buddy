// Formula recognition — pix2text-mfr (TrOCR VisionEncoderDecoder, MIT) on ONNX
// Runtime Web. Turns an Equation crop into LaTeX. The model is autoregressive
// (the one generative piece in an otherwise faithful CTC stack), so the guardrail
// is downstream: the side panel renders the LaTeX with KaTeX BESIDE the source
// crop, and abstains (shows the crop as an image) when it can't render.
//
// The export has no merged/KV-cache decoder, so we hand-roll a greedy loop that
// feeds the full growing token sequence each step (O(n^2), ~0.2-0.3s/formula —
// fine for the occasional display equation). Preproc + ByteLevel-BPE decode were
// validated against Transformers.js to float precision before shipping.

import * as ort from 'onnxruntime-web'

const ENCODER = 'models/mfr_encoder.onnx'
const DECODER = 'models/mfr_decoder.onnx'
const TOKENIZER = 'models/mfr_tokenizer.json'
const SIZE = 384 // TrOCR/DeiT input (square, non-aspect resize)
const DECODER_START = 2
const EOS = 2
const MAX_TOKENS = 256
const REPEAT_LIMIT = 12 // abort if one token repeats this many times in a row

// Memoized as a promise so concurrent formula requests share ONE init.
let sessionsPromise: Promise<[ort.InferenceSession, ort.InferenceSession]> | null = null
// True when a session refused the WebGPU EP and was recreated WASM-only — so the
// backend badge reports what actually ran, not just what the device supports.
let wasmFallback = false

/** True if formula inference fell back to the WASM-only path. */
export const formulaUsedWasm = (): boolean => wasmFallback

function getSessions(): Promise<[ort.InferenceSession, ort.InferenceSession]> {
  sessionsPromise ??= buildSessions().catch((err) => {
    sessionsPromise = null // failed init stays retryable
    throw err
  })
  return sessionsPromise
}

async function buildSessions(): Promise<[ort.InferenceSession, ort.InferenceSession]> {
  const [encBuf, decBuf] = await Promise.all([
    (await fetch(chrome.runtime.getURL(ENCODER))).arrayBuffer(),
    (await fetch(chrome.runtime.getURL(DECODER))).arrayBuffer(),
  ])
  // int8 encoder may not run on the WebGPU EP → fall back to WASM (slower, fine).
  // logSeverityLevel 3 = errors only — keeps ORT's benign EP-partition warnings
  // off the chrome://extensions error page.
  const create = (buf: ArrayBuffer) =>
    ort.InferenceSession.create(buf, {
      executionProviders: ['webgpu', 'wasm'],
      logSeverityLevel: 3,
    }).catch(() => {
      wasmFallback = true
      return ort.InferenceSession.create(buf, { executionProviders: ['wasm'], logSeverityLevel: 3 })
    })
  return Promise.all([create(encBuf), create(decBuf)])
}

// ── ByteLevel-BPE decode (id[] -> text) ──────────────────────────────────────
let idToPiece: string[] | null = null
let specialIds: Set<number> | null = null
let byteInv: Map<string, number> | null = null
const utf8 = new TextDecoder('utf-8')

function buildByteInverse(): Map<string, number> {
  const bs: number[] = []
  for (let i = 33; i <= 126; i++) bs.push(i)
  for (let i = 161; i <= 172; i++) bs.push(i)
  for (let i = 174; i <= 255; i++) bs.push(i)
  const cs = bs.slice()
  let n = 0
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n++) }
  const inv = new Map<string, number>()
  bs.forEach((b, i) => inv.set(String.fromCharCode(cs[i]), b))
  return inv
}

async function getTokenizer(): Promise<void> {
  if (idToPiece) return
  const j = await (await fetch(chrome.runtime.getURL(TOKENIZER))).json()
  const pieces: string[] = []
  for (const [piece, id] of Object.entries(j.model.vocab as Record<string, number>)) pieces[id] = piece
  idToPiece = pieces
  specialIds = new Set(
    ((j.added_tokens ?? []) as { id: number; special: boolean }[]).filter((t) => t.special).map((t) => t.id),
  )
  byteInv = buildByteInverse()
}

function decodeIds(ids: number[]): string {
  const str = ids
    .filter((id) => !specialIds!.has(id))
    .map((id) => idToPiece![id] ?? '')
    .join('')
  const bytes: number[] = []
  for (const ch of str) {
    const b = byteInv!.get(ch)
    if (b !== undefined) bytes.push(b)
  }
  return utf8.decode(new Uint8Array(bytes)).trim()
}

// ── preprocessing (crop -> CHW float tensor), validated to ~1e-7 vs Transformers.js ──
function preprocess(crop: ImageBitmap): ort.Tensor {
  const canvas = new OffscreenCanvas(SIZE, SIZE)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(crop, 0, 0, SIZE, SIZE) // non-aspect square resize
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data // RGBA
  const plane = SIZE * SIZE
  const t = new Float32Array(3 * plane)
  for (let p = 0; p < plane; p++) {
    for (let c = 0; c < 3; c++) t[c * plane + p] = (px[p * 4 + c] / 255 - 0.5) / 0.5
  }
  return new ort.Tensor('float32', t, [1, 3, SIZE, SIZE])
}

export interface FormulaResult {
  latex: string
  /** false = degenerate decode (repetition/over-length) → caller should abstain. */
  ok: boolean
}

/** Recognize a single formula crop as LaTeX. */
export async function recognizeFormula(crop: ImageBitmap): Promise<FormulaResult> {
  await getTokenizer()
  const [enc, dec] = await getSessions()

  const encOut = await enc.run({ pixel_values: preprocess(crop) })
  const ehs = encOut[enc.outputNames[0]] // last_hidden_state

  const ids: number[] = [DECODER_START]
  let repeats = 1
  let degenerate = false
  for (let step = 0; step < MAX_TOKENS; step++) {
    const idTensor = new ort.Tensor('int64', BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length])
    const out = await dec.run({ input_ids: idTensor, encoder_hidden_states: ehs })
    const logits = out[dec.outputNames[0]]
    const vocab = logits.dims[2]
    const data = logits.data as Float32Array
    const off = (ids.length - 1) * vocab
    let next = 0
    let best = -Infinity
    for (let i = 0; i < vocab; i++) {
      const v = data[off + i]
      if (v > best) { best = v; next = i }
    }
    if (next === EOS) break
    repeats = next === ids[ids.length - 1] ? repeats + 1 : 1
    if (repeats >= REPEAT_LIMIT) { degenerate = true; break }
    ids.push(next)
  }
  if (ids.length >= MAX_TOKENS) degenerate = true

  const latex = decodeIds(ids.slice(1))
  return { latex, ok: !degenerate && latex.length > 0 }
}
