// Real-image OCR test: runs Text/Code mode (the SAME PP-OCRv5 config as the
// extension) over image files and scores each against a ground-truth .txt.
//
//   node scripts/ocr-image-test.mjs                      # all pairs in test-images/
//   node scripts/ocr-image-test.mjs path/to.png [lang]   # ad-hoc: just print OCR text
//
// For each <name>.png|jpg in test-images/, if <name>.txt exists it's the ground
// truth → reports character accuracy (100 - CER%). A .txt may hold one block per
// line or the whole text; scoring is whitespace-normalized so layout differences
// don't penalize. Drop the page images + their ground-truth text here (or run
// scripts/fetch-test-images.mjs to populate it).
//
// Language packs: a `<lang>__` filename prefix (latin, en, zh, cyrillic, eslav,
// el, korean, th, devanagari, ta, te — mirrors src/offscreen/packs.ts) scores
// that file with that pack, downloading it once into .packs-cache/ (gitignored).
// `latex__` files are Formula-mode material and are skipped here.

import { PaddleOcrService } from 'ppu-paddle-ocr'
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, extname, basename } from 'node:path'

const ROOT = resolve('.')
const DIR = join(ROOT, 'test-images')
const M = join(ROOT, 'public', 'models')
const PACK_CACHE = join(ROOT, '.packs-cache')

// ── language packs (mirror of src/offscreen/packs.ts — same pinned commit) ───
const COMMIT = '3a180da5b1a3bab3371d970f4da42cb9b354a9a7'
const MEDIA = `https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/${COMMIT}`
const RAW = `https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/${COMMIT}`
const multi = (id) => ({
  rec: `${MEDIA}/recognition/multi/${id}/v5/${id}_PP-OCRv5_mobile_rec_infer.onnx`,
  dict: `${RAW}/recognition/multi/${id}/v5/ppocrv5_${id}_dict.txt`,
})
const PACKS = {
  latin: { latinFold: true }, // bundled
  en: { latinFold: true, remote: multi('en') },
  zh: { latinFold: false, remote: { rec: `${MEDIA}/recognition/PP-OCRv5_mobile_rec_infer.onnx`, dict: `${RAW}/recognition/ppocrv5_dict.txt` } },
  cyrillic: { latinFold: false, remote: multi('cyrillic') },
  eslav: { latinFold: false, remote: multi('eslav') },
  el: { latinFold: false, remote: multi('el') },
  korean: { latinFold: false, remote: multi('korean') },
  th: { latinFold: false, remote: multi('th') },
  devanagari: { latinFold: false, remote: multi('devanagari') },
  ta: { latinFold: false, remote: multi('ta') },
  te: { latinFold: false, remote: multi('te') },
}

async function download(url, dest) {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`)
  writeFileSync(dest, Buffer.from(await resp.arrayBuffer()))
}

/** Local rec+dict paths for a pack, downloading to .packs-cache/ once. */
async function packPaths(id) {
  const pack = PACKS[id]
  if (!pack) throw new Error(`unknown language pack "${id}"`)
  if (!pack.remote) {
    return {
      rec: join(M, 'latin_PP-OCRv5_mobile_rec_infer.onnx'),
      dict: join(M, 'ppocrv5_latin_dict.txt'),
    }
  }
  mkdirSync(PACK_CACHE, { recursive: true })
  const rec = join(PACK_CACHE, `${id}_rec.onnx`)
  const dict = join(PACK_CACHE, `${id}_dict.txt`)
  if (!existsSync(rec)) {
    console.log(`  downloading ${id} pack…`)
    await download(pack.remote.rec, rec)
  }
  if (!existsSync(dict)) await download(pack.remote.dict, dict)
  return { rec, dict }
}

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
function proseFromLines(lines, fold) {
  const flat = lines.flat().filter(hasText)
  if (!flat.length) return ''
  const charW = median(flat.map((w) => w.box.width / w.text.length)) || 1
  const rows = []
  for (const line of lines) {
    const ws = line.filter(hasText).sort((a, b) => a.box.x - b.box.x)
    if (!ws.length) continue
    // The homoglyph/digit folds only apply to Latin-script packs.
    if (fold) for (const w of ws) w.text = deHomoglyph(w.text)
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

// ── services (same config as the extension), one per language pack ───────────
const services = new Map()
async function serviceFor(langId) {
  if (services.has(langId)) return services.get(langId)
  const { rec, dict } = await packPaths(langId)
  const service = new PaddleOcrService({
    model: {
      detection: join(M, 'PP-OCRv5_mobile_det_infer.onnx'),
      recognition: rec,
      charactersDictionary: dict,
    },
    recognition: { strategy: 'per-box' },
    detection: { maxSideLength: 1280 },
    processing: { engine: 'canvas-native' },
  })
  await service.initialize()
  services.set(langId, service)
  return service
}
async function destroyAll() {
  for (const s of services.values()) await s.destroy?.()
}

/** `<lang>__name.png` → that pack; no prefix → latin. */
const langOf = (name) => (name.includes('__') ? name.split('__')[0] : 'latin')

async function ocr(file, langId = 'latin') {
  const service = await serviceFor(langId)
  const buf = readFileSync(file)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const res = await service.recognize(ab, { flatten: false })
  return proseFromLines(groupReadingOrder(res.lines.flat()), PACKS[langId]?.latinFold ?? true)
}

// ── ad-hoc single file, or score the test-images/ dir ─────────────────────────
const adhoc = process.argv[2]
if (adhoc) {
  console.log(await ocr(resolve(adhoc), process.argv[3] ?? langOf(basename(adhoc))))
  await destroyAll()
  process.exit(0)
}

if (!existsSync(DIR)) { console.error(`No test-images/ dir. Create it and drop <name>.png + <name>.txt pairs.`); process.exit(1) }
const imgs = readdirSync(DIR).filter((f) => ['.png', '.jpg', '.jpeg'].includes(extname(f).toLowerCase()))
if (!imgs.length) { console.error(`test-images/ is empty. Drop <name>.png + <name>.txt (ground truth) pairs.`); process.exit(1) }

let scored = 0, sumAcc = 0
for (const f of imgs) {
  const name = basename(f, extname(f))
  const langId = langOf(name)
  if (langId === 'latex') continue // Formula-mode material; not text OCR
  const got = await ocr(join(DIR, f), langId)
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
  console.log(`\n=== ${f} [${langId}] === accuracy ${acc.toFixed(1)}/100 (CER ${(cer * 100).toFixed(1)}%)`)
  if (acc < 100) {
    console.log(`--- expected ---\n${norm(expected)}`)
    console.log(`--- got ---\n${ng}`)
  }
}
if (scored) console.log(`\nOVERALL: ${(sumAcc / scored).toFixed(1)}/100 over ${scored} scored image(s)`)
await destroyAll()
