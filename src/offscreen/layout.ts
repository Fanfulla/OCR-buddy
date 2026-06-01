// Document layout detection — PicoDet CDLA (RapidLayout, Apache-2.0, ~7.4 MB) on
// ONNX Runtime Web. Detects regions (Text/Title/Table/Figure/Equation/…) with
// boxes, so Document mode can route each region to the right handler. Pre/post-
// process replicate RapidLayout's PP pipeline (validated against a real paper).

import * as ort from 'onnxruntime-web'

const MODEL = 'models/layout_cdla.onnx'
const IW = 608
const IH = 800
const NUMC = 10
const STRIDES = [8, 16, 32, 64]
const CONF = 0.4
const IOU = 0.5
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]
// CDLA class order (confirmed against detections on a real PMC paper).
const LABELS = ['Text', 'Title', 'Figure', 'Figure caption', 'Table', 'Table caption', 'Header', 'Footer', 'Reference', 'Equation'] as const
export type LayoutLabel = (typeof LABELS)[number]

export interface Region {
  label: LayoutLabel
  score: number
  box: { x: number; y: number; width: number; height: number } // original-image px
}

let session: ort.InferenceSession | null = null
async function getSession(): Promise<ort.InferenceSession> {
  if (session) return session
  const buf = await (await fetch(chrome.runtime.getURL(MODEL))).arrayBuffer()
  // wasmPaths / numThreads are configured globally in engine.ts.
  try {
    session = await ort.InferenceSession.create(buf, { executionProviders: ['webgpu', 'wasm'] })
  } catch {
    session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] })
  }
  return session
}

const softmax = (a: number[]): number[] => {
  const m = Math.max(...a)
  const e = a.map((v) => Math.exp(v - m))
  const s = e.reduce((x, y) => x + y, 0)
  return e.map((v) => v / s)
}
const iouOf = (a: number[], b: number[]): number => {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1])
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3])
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const ar = (q: number[]) => (q[2] - q[0]) * (q[3] - q[1])
  return inter / (ar(a) + ar(b) - inter + 1e-5)
}

/** Detect document regions in an image. Returns boxes in original-image coords. */
export async function detectLayout(bitmap: ImageBitmap): Promise<Region[]> {
  const ow = bitmap.width
  const oh = bitmap.height

  // Resize (plain, non-aspect) to the model's input and read pixels.
  const canvas = new OffscreenCanvas(IW, IH)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, IW, IH)
  const px = ctx.getImageData(0, 0, IW, IH).data // RGBA

  // BGR-normalized CHW tensor (matches RapidLayout).
  const plane = IH * IW
  const t = new Float32Array(3 * plane)
  for (let p = 0; p < plane; p++) {
    const r = px[p * 4], g = px[p * 4 + 1], b = px[p * 4 + 2]
    t[p] = (b / 255 - MEAN[0]) / STD[0]
    t[plane + p] = (g / 255 - MEAN[1]) / STD[1]
    t[2 * plane + p] = (r / 255 - MEAN[2]) / STD[2]
  }

  const sess = await getSession()
  const out = await sess.run({ image: new ort.Tensor('float32', t, [1, 3, IH, IW]) })
  const tensors = sess.outputNames.map((n) => out[n])

  const lastDim = (o: ort.Tensor) => o.dims[o.dims.length - 1]
  const cells = (o: ort.Tensor) => o.dims[1]
  const scoreT = tensors.filter((o) => lastDim(o) === NUMC).sort((a, b) => cells(b) - cells(a))
  const boxT = tensors.filter((o) => lastDim(o) !== NUMC).sort((a, b) => cells(b) - cells(a))
  const regBins = lastDim(boxT[0]) / 4

  const perClass: { box: number[]; score: number }[][] = Array.from({ length: NUMC }, () => [])
  for (let lv = 0; lv < 4; lv++) {
    const stride = STRIDES[lv]
    const fmW = Math.ceil(IW / stride)
    const fmH = Math.ceil(IH / stride)
    const sData = scoreT[lv].data as Float32Array
    const bData = boxT[lv].data as Float32Array
    for (let hh = 0; hh < fmH; hh++) {
      for (let ww = 0; ww < fmW; ww++) {
        const cell = hh * fmW + ww
        let max = 0
        for (let c = 0; c < NUMC; c++) max = Math.max(max, sData[cell * NUMC + c])
        if (max <= CONF) continue
        const d = [0, 0, 0, 0]
        for (let s = 0; s < 4; s++) {
          const bins: number[] = []
          for (let k = 0; k < regBins; k++) bins.push(bData[cell * 4 * regBins + s * regBins + k])
          const p = softmax(bins)
          let dist = 0
          for (let k = 0; k < regBins; k++) dist += p[k] * k
          d[s] = dist * stride
        }
        const ctCol = (ww + 0.5) * stride
        const ctRow = (hh + 0.5) * stride
        const box = [ctCol - d[0], ctRow - d[1], ctCol + d[2], ctRow + d[3]]
        for (let c = 0; c < NUMC; c++) {
          const sc = sData[cell * NUMC + c]
          if (sc > CONF) perClass[c].push({ box, score: sc })
        }
      }
    }
  }

  // Global (cross-class) NMS + containment suppression. The model emits several
  // class hypotheses for one physical region (e.g. a tight table crop fires Table,
  // Figure AND Figure-caption over the same area); per-class NMS alone would keep
  // all of them. Sort every detection by score and greedily keep a box only if it
  // neither overlaps (IOU) nor sits mostly inside an already-kept box — so each
  // region resolves to its single highest-scoring label.
  const contained = (inner: number[], outer: number[]): number => {
    const x1 = Math.max(inner[0], outer[0]), y1 = Math.max(inner[1], outer[1])
    const x2 = Math.min(inner[2], outer[2]), y2 = Math.min(inner[3], outer[3])
    const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
    const a = (inner[2] - inner[0]) * (inner[3] - inner[1])
    return a > 0 ? i / a : 0
  }
  const all = perClass
    .flatMap((arr, c) => arr.map((d) => ({ ...d, c })))
    .sort((a, b) => b.score - a.score)
  const kept: { box: number[]; score: number; c: number }[] = []
  for (const d of all) {
    if (kept.some((k) => iouOf(k.box, d.box) > IOU || contained(d.box, k.box) > 0.7)) continue
    kept.push(d)
  }

  const sx = IW / ow
  const sy = IH / oh
  return kept.map((d) => {
    const x1 = Math.max(0, Math.min(ow, d.box[0] / sx))
    const y1 = Math.max(0, Math.min(oh, d.box[1] / sy))
    const x2 = Math.max(0, Math.min(ow, d.box[2] / sx))
    const y2 = Math.max(0, Math.min(oh, d.box[3] / sy))
    return { label: LABELS[d.c], score: d.score, box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } }
  })
}
