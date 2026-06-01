// The OCR engine, shared by the offscreen document (production path) and the
// testbed page (automated verification). Wraps ppu-paddle-ocr (PP-OCRv5, faithful
// CTC) on ONNX Runtime Web, with bundled models and self-hosted wasm.
//
// On top of recognition it adds two preprocessing/post-processing steps:
//  - smart upscaling of small crops (low-res video frames) before detection;
//  - code-view reconstruction of line breaks + indentation from box geometry.

import * as ort from 'onnxruntime-web'
import { PaddleOcrService, isWebGpuAvailable } from 'ppu-paddle-ocr/web'
import type { RecognitionOptions, RecognitionResult } from 'ppu-paddle-ocr/web'
import { recognizeFormula } from './formula'
import type { DocBlock, OcrWord } from '../shared/messages'

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
    // per-box: recognize each detected box on its OWN crop. The default per-line
    // strategy merges a line's box crops side-by-side into one image, so adjacent
    // words lose the gap pixels and run together ("stop doing code" → "stopdoing-
    // code") and surplus boxes get blanked. per-box keeps each crop's real gaps,
    // so the recognizer emits spaces; we add inter-box spacing from geometry.
    // (charactersDictionary is loaded from model.charactersDictionary at runtime;
    // the type marks it required, so cast.)
    recognition: { strategy: 'per-box' } as RecognitionOptions,
    // Keep ppu's default horizontal padding — tightening it cut off edge glyphs
    // ("Rafael" → "Rafae"). per-box already gives correct spacing.
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

const hasText = (w: RecognitionResult): boolean => w.text.trim().length > 0

// Our recognizer is Latin-only, so any Greek/Cyrillic glyph it emits is a misread
// of a visually identical Latin letter (e.g. Latin "v" → Greek "ν"). Map the
// well-known look-alikes back to Latin; leave anything without a clean equivalent
// untouched (don't guess).
const HOMOGLYPHS: Record<string, string> = {
  // Greek → Latin
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N',
  Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X', α: 'a', ε: 'e', ι: 'i', κ: 'k',
  ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
  // Cyrillic → Latin
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C',
  Т: 'T', У: 'Y', Х: 'X', а: 'a', в: 'v', е: 'e', к: 'k', м: 'm', н: 'h',
  о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
}
const deHomoglyph = (s: string): string =>
  Array.from(s, (ch) => HOMOGLYPHS[ch] ?? ch).join('')

// Same spirit as the homoglyph fold, for the one ambiguous Latin pair: an 'o'/'O'
// wedged between a non-zero digit and a digit is a misread '0' ("4o0" → "400").
// Requiring a 1–9 before keeps code identifiers (x0, arg0), ordinary words, and
// the octal prefix "0o" (0o755) intact — important for Text/Code mode.
const fixDigitOh = (s: string): string => s.replace(/(?<=[1-9])[oO](?=\d)/g, '0')

interface Row {
  raw: number // leading indent in char units
  text: string // line text with intra-line spacing reconstructed from gaps
  top: number // line's top y (for blank-line detection)
}

/** Group a column's boxes into visual lines (by vertical overlap), each sorted
 * left-to-right, lines top-to-bottom. */
function groupLines(boxes: RecognitionResult[], lineH: number): RecognitionResult[][] {
  const sorted = [...boxes].sort((a, b) => a.box.y - b.box.y)
  const lines: { cy: number; items: RecognitionResult[] }[] = []
  for (const b of sorted) {
    const cy = b.box.y + b.box.height / 2
    const last = lines[lines.length - 1]
    if (last && Math.abs(cy - last.cy) < lineH * 0.6) last.items.push(b)
    else lines.push({ cy, items: [b] })
  }
  return lines.map((l) => l.items.sort((a, b) => a.box.x - b.box.x))
}

/**
 * Reading order, column-aware. Cluster boxes into columns by gaps in horizontal
 * coverage wider than a gutter threshold, then read each column top-to-bottom,
 * columns left-to-right. Fixes multi-column papers that the engine's full-width
 * line grouping reads as interleaved. A single-column capture yields one column
 * → unchanged.
 */
function groupReadingOrder(boxes: RecognitionResult[]): RecognitionResult[][] {
  const ws = boxes.filter(hasText)
  if (!ws.length) return []
  const lineH = median(ws.map((b) => b.box.height)) || 1
  const minX = Math.min(...ws.map((b) => b.box.x))
  const maxX = Math.max(...ws.map((b) => b.box.x + b.box.width))
  const colGap = Math.max(lineH * 1.4, (maxX - minX) * 0.045)

  // Merge x-intervals into column bands; a gap wider than colGap starts a new band.
  const intervals = ws
    .map((b) => [b.box.x, b.box.x + b.box.width] as [number, number])
    .sort((a, b) => a[0] - b[0])
  const bands: { x0: number; x1: number }[] = []
  for (const [s, e] of intervals) {
    const last = bands[bands.length - 1]
    if (last && s - last.x1 <= colGap) last.x1 = Math.max(last.x1, e)
    else bands.push({ x0: s, x1: e })
  }

  const colOf = (b: RecognitionResult) => {
    const cx = b.box.x + b.box.width / 2
    const i = bands.findIndex((band) => cx >= band.x0 && cx <= band.x1)
    return i < 0 ? 0 : i
  }

  const out: RecognitionResult[][] = []
  for (let c = 0; c < bands.length; c++) {
    out.push(...groupLines(ws.filter((b) => colOf(b) === c), lineH))
  }
  return out
}

/**
 * Build one Row per visual line from box geometry. The recognizer dict has no
 * space token, so spacing is reconstructed: a space wherever there's a gap
 * between adjacent boxes. Empty/whitespace boxes (detection produces duplicate
 * blanks) are dropped. charW = median(box.width / text.length) is the glyph
 * advance and cancels the upscale factor.
 */
function buildRows(lines: RecognitionResult[][]): { rows: Row[]; charW: number } {
  const flat = lines.flat().filter(hasText)
  if (!flat.length) return { rows: [], charW: 1 }

  const charW = median(flat.map((w) => w.box.width / w.text.length)) || 1
  const minLeft = Math.min(...flat.map((w) => w.box.x))

  const rows: Row[] = []
  for (const line of lines) {
    const ws = line.filter(hasText).sort((a, b) => a.box.x - b.box.x)
    if (!ws.length) continue
    let text = ws[0].text
    for (let i = 1; i < ws.length; i++) {
      const gap = ws[i].box.x - (ws[i - 1].box.x + ws[i - 1].box.width)
      text += ' '.repeat(Math.max(1, Math.round(gap / charW))) + ws[i].text
    }
    const top = Math.min(...ws.map((w) => w.box.y))
    rows.push({ raw: (ws[0].box.x - minLeft) / charW, text, top })
  }
  return { rows, charW }
}

/**
 * Code view: prose lines + leading indentation, with blank lines restored. Indent
 * is quantized — detect the one-level unit (smallest clear positive offset) and
 * snap to whole levels × 4 spaces, recovering clean nesting despite box-padding
 * inflating charW. Blank lines are inferred from vertical gaps: when two lines are
 * ~N line-pitches apart, insert N-1 blank lines between them.
 */
function toCodeText(rows: Row[]): string {
  if (!rows.length) return ''
  const positives = rows.map((r) => r.raw).filter((v) => v > 0.5)
  const unit = positives.length ? Math.min(...positives) : 0
  const quantize = unit > 0.5 && unit < 12
  const indentOf = (r: Row) =>
    quantize ? Math.max(0, Math.round(r.raw / unit)) * INDENT_SPACES : Math.max(0, Math.round(r.raw))

  // Typical line-to-line distance, used to detect blank lines.
  const diffs: number[] = []
  for (let i = 1; i < rows.length; i++) diffs.push(rows[i].top - rows[i - 1].top)
  const pitch = median(diffs.filter((d) => d > 0))

  const out: string[] = []
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && pitch > 0) {
      const blanks = Math.max(0, Math.round((rows[i].top - rows[i - 1].top) / pitch) - 1)
      for (let b = 0; b < blanks; b++) out.push('')
    }
    out.push(' '.repeat(indentOf(rows[i])) + rows[i].text)
  }
  return out.join('\n')
}

/** Run detection + recognition on encoded image bytes (e.g. a PNG ArrayBuffer). */
export async function recognizeBuffer(imageBuffer: ArrayBuffer): Promise<OcrOutput> {
  const svc = await getService()
  const canvas = await prepareImage(imageBuffer)
  const res = await svc.recognize(canvas, { flatten: false })

  // Latin-only recognizer: fold stray Greek/Cyrillic look-alikes back to Latin,
  // and a digit-context 'o'→'0' (e.g. "4o0" → "400").
  for (const line of res.lines) for (const w of line) w.text = fixDigitOh(deHomoglyph(w.text))

  // Re-group into column-aware reading order (fixes multi-column papers that the
  // engine's full-width line grouping would otherwise read interleaved).
  const lines = groupReadingOrder(res.lines.flat())

  // Carry the line index so the prose view breaks exactly where text wraps.
  const words: OcrWord[] = []
  lines.forEach((line, li) => {
    for (const r of line) {
      words.push({ text: r.text, confidence: r.confidence, box: r.box, line: li })
    }
  })

  const { rows } = buildRows(lines)

  return {
    text: rows.map((r) => r.text).join('\n'), // prose: gap-spaced, no indent
    codeText: toCodeText(rows),
    words,
    backend,
    empty: rows.length === 0,
    lines,
  }
}

// ── Table mode: OCR the crop, then rebuild a grid from word-box geometry ──────

/**
 * Reconstruct a Markdown table from a table region's OCR word boxes: cluster into
 * rows by y, find columns from the x coverage profile (gutters = x-bins covered by
 * few words, robust to the odd wide cell bridging a gap), place each word in its
 * nearest column. Pure geometry — no extra model. Best-effort; complex numeric
 * tables may mis-split. Returns null when it isn't grid-like.
 */
function reconstructTable(words: OcrWord[]): string | null {
  const ws = words.filter((w) => w.text.trim().length > 0)
  if (ws.length < 4) return null
  const medH = median(ws.map((w) => w.box.height)) || 1

  // Rows by vertical position.
  const rows: OcrWord[][] = []
  let curY = -Infinity
  for (const w of [...ws].sort((a, b) => a.box.y - b.box.y)) {
    const cy = w.box.y + w.box.height / 2
    if (!rows.length || Math.abs(cy - curY) > medH * 0.7) {
      rows.push([])
      curY = cy
    }
    rows[rows.length - 1].push(w)
  }
  if (rows.length < 2) return null

  const xMin = Math.min(...ws.map((w) => w.box.x))
  const xMax = Math.max(...ws.map((w) => w.box.x + w.box.width))
  const tableW = Math.max(1, xMax - xMin)
  // A single wide box on its own line is a merged header or a caption/title, not a
  // data row — it would bridge the inter-column gutters. Find columns from the data
  // rows only (>=2 boxes with real gaps).
  const isSpan = (row: OcrWord[]) => row.length === 1 && row[0].box.width > 0.55 * tableW
  const dataRows = rows.filter((row) => !isSpan(row))
  if (dataRows.length < 2) return null

  // Columns from the x coverage profile: a gutter is a run of x-bins covered by
  // <~18% of data rows; columns are the populated runs between gutters.
  const bin = Math.max(2, Math.round(medH * 0.3))
  const nb = Math.ceil((xMax - xMin) / bin) + 1
  const cov = new Array(nb).fill(0)
  for (const w of dataRows.flat()) {
    const a = Math.floor((w.box.x - xMin) / bin)
    const b = Math.floor((w.box.x + w.box.width - xMin) / bin)
    for (let i = Math.max(0, a); i <= Math.min(nb - 1, b); i++) cov[i]++
  }
  const gut = Math.max(1, dataRows.length * 0.18)
  const isGut = cov.map((c) => c <= gut)
  const cols: [number, number][] = []
  let start = -1
  for (let i = 0; i < nb; i++) {
    if (!isGut[i]) {
      if (start < 0) start = i
    } else if (start >= 0) {
      let j = i
      while (j < nb && isGut[j]) j++
      if (j - i >= 2 || j >= nb) {
        cols.push([xMin + start * bin, xMin + i * bin])
        start = -1
        i = j - 1
      }
    }
  }
  if (start >= 0) cols.push([xMin + start * bin, xMin + nb * bin])
  if (cols.length < 2) return null // not a table

  const center = (c: [number, number]) => (c[0] + c[1]) / 2
  const colOf = (w: OcrWord) => {
    const cx = w.box.x + w.box.width / 2
    let nearest = 0
    let best = Infinity
    cols.forEach((c, i) => {
      const d = Math.abs(cx - center(c))
      if (d < best) {
        best = d
        nearest = i
      }
    })
    return nearest
  }

  const ncol = cols.length
  // Build the grid. A single wide box whose word count matches the column count is a
  // header split across the columns ("Parameters Decoder Encoder"); otherwise it's a
  // caption/prose line and is dropped from the grid.
  const grid: string[][] = []
  for (const row of rows) {
    const cells = Array.from({ length: ncol }, () => '')
    if (isSpan(row)) {
      const parts = row[0].text.trim().split(/\s+/)
      if (parts.length !== ncol) continue
      parts.forEach((p, i) => (cells[i] = p))
    } else {
      for (const w of [...row].sort((a, b) => a.box.x - b.box.x)) {
        const c = colOf(w)
        cells[c] = cells[c] ? `${cells[c]} ${w.text}` : w.text
      }
    }
    if (cells.some((c) => c.trim())) grid.push(cells.map((c) => c.trim()))
  }
  if (grid.length < 2) return null

  const esc = (s: string) => s.replace(/\|/g, '\\|')
  const md = [
    `| ${grid[0].map(esc).join(' | ')} |`,
    `| ${grid[0].map(() => '---').join(' | ')} |`,
    ...grid.slice(1).map((r) => `| ${r.map(esc).join(' | ')} |`),
  ]
  return md.join('\n')
}

/** Table mode: OCR the whole crop and rebuild the grid by geometry — no layout
 * model, so borderless tables (which the page-layout model misreads as Figure)
 * work. Falls back to plain text when the crop isn't grid-like. */
export async function recognizeTableImage(
  imageBuffer: ArrayBuffer,
): Promise<{ docBlocks: DocBlock[]; docText: string; backend: 'webgpu' | 'wasm'; empty: boolean }> {
  const out = await recognizeBuffer(imageBuffer)
  const md = reconstructTable(out.words)
  if (md) return { docBlocks: [{ kind: 'table', markdown: md }], docText: md, backend, empty: false }
  const text = out.text.trim()
  return {
    docBlocks: text ? [{ kind: 'paragraph', text }] : [],
    docText: text,
    backend,
    empty: !text,
  }
}

/** Formula mode: recognize one captured equation crop as LaTeX. */
export async function recognizeFormulaImage(
  imageBuffer: ArrayBuffer,
): Promise<{ latex: string; ok: boolean; backend: 'webgpu' | 'wasm' }> {
  // No PP-OCR service runs in this path, so resolve the backend label directly.
  backend = (await isWebGpuAvailable()) ? 'webgpu' : 'wasm'
  const bitmap = await createImageBitmap(new Blob([imageBuffer]))
  const r = await recognizeFormula(bitmap)
  bitmap.close()
  return { ...r, backend }
}
