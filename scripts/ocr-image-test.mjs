// Real-image OCR test: runs Text/Code mode (the SAME PP-OCRv5 config as the
// extension) over image files and scores each against a ground-truth .txt.
//
//   node scripts/ocr-image-test.mjs                 # all pairs in test-images/
//   node scripts/ocr-image-test.mjs path/to.png     # ad-hoc: just print OCR text
//
// For each <name>.png|jpg in test-images/, if <name>.txt exists it's the ground
// truth → reports character accuracy (100 - CER%). A .txt may hold one block per
// line or the whole text; scoring is whitespace-normalized so layout differences
// don't penalize. Drop the page images + their ground-truth text here.

import { PaddleOcrService } from 'ppu-paddle-ocr'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, extname, basename } from 'node:path'

const ROOT = resolve('.')
const DIR = join(ROOT, 'test-images')
const M = join(ROOT, 'public', 'models')

// ── reading order + prose assembly (mirror of engine.ts / ocr-bench.mjs) ──────
const HOMO = { Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', ν: 'v', ο: 'o', ρ: 'p', τ: 't', а: 'a', е: 'e', о: 'o', с: 'c', р: 'p', у: 'y', х: 'x' }
const deHomoglyph = (s) => Array.from(s, (c) => HOMO[c] ?? c).join('').replace(/(?<=[1-9])[oO](?=\d)/g, '0')
const hasText = (w) => w.text.trim().length > 0
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
function groupLines(boxes, lineH) {
  const sorted = [...boxes].sort((a, b) => a.box.y - b.box.y)
  const lines = []
  for (const b of sorted) {
    const cy = b.box.y + b.box.height / 2
    const last = lines[lines.length - 1]
    if (last && Math.abs(cy - last.cy) < lineH * 0.6) last.items.push(b)
    else lines.push({ cy, items: [b] })
  }
  return lines.map((l) => l.items.sort((a, b) => a.box.x - b.box.x))
}
function groupReadingOrder(boxes) {
  const ws = boxes.filter(hasText)
  if (!ws.length) return []
  const lineH = median(ws.map((b) => b.box.height)) || 1
  const minX = Math.min(...ws.map((b) => b.box.x))
  const maxX = Math.max(...ws.map((b) => b.box.x + b.box.width))
  const colGap = Math.max(lineH * 1.4, (maxX - minX) * 0.045)
  const intervals = ws.map((b) => [b.box.x, b.box.x + b.box.width]).sort((a, b) => a[0] - b[0])
  const bands = []
  for (const [s, e] of intervals) {
    const last = bands[bands.length - 1]
    if (last && s - last.x1 <= colGap) last.x1 = Math.max(last.x1, e)
    else bands.push({ x0: s, x1: e })
  }
  const colOf = (b) => { const cx = b.box.x + b.box.width / 2; const i = bands.findIndex((bd) => cx >= bd.x0 && cx <= bd.x1); return i < 0 ? 0 : i }
  const out = []
  for (let c = 0; c < bands.length; c++) out.push(...groupLines(ws.filter((b) => colOf(b) === c), lineH))
  return out
}
function proseFromLines(lines) {
  const flat = lines.flat().filter(hasText)
  if (!flat.length) return ''
  const charW = median(flat.map((w) => w.box.width / w.text.length)) || 1
  const rows = []
  for (const line of lines) {
    const ws = line.filter(hasText).sort((a, b) => a.box.x - b.box.x)
    if (!ws.length) continue
    for (const w of ws) w.text = deHomoglyph(w.text)
    let text = ws[0].text
    for (let i = 1; i < ws.length; i++) {
      const gap = ws[i].box.x - (ws[i - 1].box.x + ws[i - 1].box.width)
      text += ' '.repeat(Math.max(1, Math.round(gap / charW))) + ws[i].text
    }
    rows.push(text)
  }
  return rows.join('\n')
}
const norm = (s) => s.replace(/\s+/g, ' ').trim()
function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (!m) return n; if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j), curr = new Array(n + 1)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) { const cost = a[i - 1] === b[j - 1] ? 0 : 1; curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost) }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

// ── service (same config as the extension) ───────────────────────────────────
const service = new PaddleOcrService({
  model: {
    detection: join(M, 'PP-OCRv5_mobile_det_infer.onnx'),
    recognition: join(M, 'latin_PP-OCRv5_mobile_rec_infer.onnx'),
    charactersDictionary: join(M, 'ppocrv5_latin_dict.txt'),
  },
  recognition: { strategy: 'per-box' },
  detection: { maxSideLength: 1280 },
  processing: { engine: 'canvas-native' },
})
await service.initialize()

async function ocr(file) {
  const buf = readFileSync(file)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const res = await service.recognize(ab, { flatten: false })
  return proseFromLines(groupReadingOrder(res.lines.flat()))
}

// ── ad-hoc single file, or score the test-images/ dir ─────────────────────────
const adhoc = process.argv[2]
if (adhoc) {
  console.log(await ocr(resolve(adhoc)))
  await service.destroy?.()
  process.exit(0)
}

if (!existsSync(DIR)) { console.error(`No test-images/ dir. Create it and drop <name>.png + <name>.txt pairs.`); process.exit(1) }
const imgs = readdirSync(DIR).filter((f) => ['.png', '.jpg', '.jpeg'].includes(extname(f).toLowerCase()))
if (!imgs.length) { console.error(`test-images/ is empty. Drop <name>.png + <name>.txt (ground truth) pairs.`); process.exit(1) }

let scored = 0, sumAcc = 0
for (const f of imgs) {
  const name = basename(f, extname(f))
  const got = await ocr(join(DIR, f))
  const gtPath = join(DIR, name + '.txt')
  if (!existsSync(gtPath)) {
    console.log(`\n=== ${f} (no ${name}.txt → OCR only) ===\n${got}`)
    continue
  }
  const expected = readFileSync(gtPath, 'utf8')
  const ne = norm(expected), ng = norm(got)
  const cer = levenshtein(ng, ne) / Math.max(1, ne.length)
  const acc = Math.max(0, 100 - cer * 100)
  scored++; sumAcc += acc
  console.log(`\n=== ${f} === accuracy ${acc.toFixed(1)}/100 (CER ${(cer * 100).toFixed(1)}%)`)
  if (acc < 100) {
    console.log(`--- expected ---\n${norm(expected)}`)
    console.log(`--- got ---\n${ng}`)
  }
}
if (scored) console.log(`\nOVERALL: ${(sumAcc / scored).toFixed(1)}/100 over ${scored} scored image(s)`)
await service.destroy?.()
