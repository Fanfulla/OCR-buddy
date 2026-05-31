// Autonomous OCR benchmark (Node, CPU — no browser/Playwright).
// Runs the SAME PP-OCRv5 model + config as the extension (per-box strategy,
// maxSideLength 1280, canvas-native) over 20 varied text images and reports
// expected-vs-got with a character error rate (CER).
//
//   node scripts/ocr-bench.mjs
//
import { PaddleOcrService } from 'ppu-paddle-ocr'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve('.')
const BENCH = join(ROOT, 'scripts', 'ocr-bench')
const IMG = join(BENCH, 'img')
mkdirSync(IMG, { recursive: true })

const BLACK = [0, 0, 0]
const WHITE = [255, 255, 255]

// name, lines (rendered + expected), font/style/colour/size, canvas w×h.
const cases = [
  { name: '01_prose_light', lines: ['The quick brown fox jumps over the lazy dog.'], font: 'Arial', size: 30, fg: BLACK, bg: WHITE, w: 720, h: 64 },
  { name: '02_prose_dark', lines: ['Why you should stop doing code reviews!'], font: 'Segoe UI', size: 38, fg: WHITE, bg: BLACK, w: 760, h: 72 },
  { name: '03_code_python', lines: ['def add(a, b):', '    return a + b'], font: 'Consolas', size: 26, fg: BLACK, bg: WHITE, w: 360, h: 100 },
  { name: '04_code_symbols', lines: ['const x = arr[0];', 'if (x > 1) { y--; }'], font: 'Consolas', size: 24, fg: BLACK, bg: WHITE, w: 360, h: 100 },
  { name: '05_numbers', lines: ['Order 12345 total $67.89 (-3.5%)'], font: 'Arial', size: 28, fg: BLACK, bg: WHITE, w: 560, h: 60 },
  { name: '06_punctuation', lines: ['Hello, world! Is this correct? Yes: it works.'], font: 'Arial', size: 28, fg: BLACK, bg: WHITE, w: 700, h: 60 },
  { name: '07_narrow_words', lines: ['I am a dev. A B C I O U'], font: 'Arial', size: 30, fg: BLACK, bg: WHITE, w: 520, h: 60 },
  { name: '08_long_line', lines: ['Code review enables verification of new code quality.'], font: 'Arial', size: 26, fg: BLACK, bg: WHITE, w: 760, h: 56 },
  { name: '09_multiline', lines: ['First line of text.', 'Second line here.', 'Third and final line.'], font: 'Arial', size: 26, fg: BLACK, bg: WHITE, w: 420, h: 150 },
  { name: '10_lowres_small', lines: ['small low resolution text'], font: 'Arial', size: 13, fg: BLACK, bg: WHITE, w: 240, h: 32 },
  { name: '11_allcaps', lines: ['STOP DOING CODE REVIEWS'], font: 'Arial', size: 32, bold: true, fg: BLACK, bg: WHITE, w: 560, h: 64 },
  { name: '12_italic', lines: ['This sentence is in italics.'], font: 'Arial', size: 28, italic: true, fg: BLACK, bg: WHITE, w: 480, h: 60 },
  { name: '13_mono_line', lines: ['printf("hello %d", n);'], font: 'Consolas', size: 26, fg: BLACK, bg: WHITE, w: 420, h: 60 },
  { name: '14_url', lines: ['Visit https://example.com today'], font: 'Arial', size: 26, fg: BLACK, bg: WHITE, w: 540, h: 56 },
  { name: '15_accented_it', lines: ['Perché è così, città università.'], font: 'Arial', size: 28, fg: BLACK, bg: WHITE, w: 560, h: 60 },
  { name: '16_math', lines: ['5 + 3 = 8 and 50% off'], font: 'Arial', size: 30, fg: BLACK, bg: WHITE, w: 460, h: 60 },
  { name: '17_multi_space', lines: ['columns    aligned    here'], font: 'Consolas', size: 26, fg: BLACK, bg: WHITE, w: 540, h: 56 },
  { name: '18_json', lines: ['{"name": "ocr", "v": 2}'], font: 'Consolas', size: 26, fg: BLACK, bg: WHITE, w: 420, h: 56 },
  { name: '19_inline_code', lines: ['Use the useState hook in React.'], font: 'Arial', size: 28, fg: BLACK, bg: WHITE, w: 540, h: 60 },
  { name: '20_path', lines: ['C:\\Users\\salvo\\file.txt'], font: 'Consolas', size: 26, fg: BLACK, bg: WHITE, w: 420, h: 56 },
]

// --- Render the images via PowerShell + System.Drawing ----------------------
const casesPath = join(BENCH, 'cases.json')
writeFileSync(casesPath, JSON.stringify(cases))
console.log('Rendering 20 test images…')
console.log(
  execFileSync('pwsh', ['-NoProfile', '-File', join(ROOT, 'scripts', 'render-cases.ps1'), '-CasesJson', casesPath, '-OutDir', IMG], { encoding: 'utf8' }).trim(),
)

// --- Reconstruction (mirrors src/offscreen/engine.ts) -----------------------
const HOMO = { Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', ν: 'v', ο: 'o', ρ: 'p', τ: 't', а: 'a', е: 'e', о: 'o', с: 'c', р: 'p', у: 'y', х: 'x' }
const deHomoglyph = (s) => Array.from(s, (c) => HOMO[c] ?? c).join('')
const hasText = (w) => w.text.trim().length > 0
const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
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

// --- Scoring ----------------------------------------------------------------
const norm = (s) => s.replace(/\s+/g, ' ').trim()
function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  let curr = new Array(n + 1)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

// --- Load models + service (same config as the extension) -------------------
const M = join(ROOT, 'public', 'models')
console.log('Loading PP-OCRv5 model (onnxruntime-node)…')
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

// --- Run --------------------------------------------------------------------
const results = []
for (const c of cases) {
  const expected = c.lines.join('\n')
  let got = ''
  let err = null
  try {
    const buf = readFileSync(join(IMG, c.name + '.png'))
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const res = await service.recognize(ab, { flatten: false })
    got = proseFromLines(res.lines)
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  const ne = norm(expected), ng = norm(got)
  const cer = err ? 1 : levenshtein(ng, ne) / Math.max(1, ne.length)
  results.push({ name: c.name, expected, got, cer, exact: ng === ne, err })
  console.log(`${c.name.padEnd(18)} CER=${(cer * 100).toFixed(1).padStart(5)}%  ${ng === ne ? 'EXACT' : ''}`)
}

await service.destroy?.()

// --- Report -----------------------------------------------------------------
const avgCer = results.reduce((s, r) => s + r.cer, 0) / results.length
const exactN = results.filter((r) => r.exact).length
const good = results.filter((r) => r.cer <= 0.05).length

let md = `# OCR benchmark — PP-OCRv5 mobile (latin), per-box\n\n`
md += `Date: ${new Date().toISOString().slice(0, 10)} · CPU (onnxruntime-node) · same config as the extension.\n\n`
md += `**Summary:** ${exactN}/20 exact · ${good}/20 within 5% CER · avg CER ${(avgCer * 100).toFixed(1)}%\n\n`
md += `> Note: this CPU run skips the in-extension upscaling of small crops, so the low-res case is a worst case here.\n\n`
md += `| # | case | CER | expected → got |\n|---|---|---|---|\n`
for (const r of results) {
  const e = r.expected.replace(/\n/g, ' ⏎ ').replace(/\|/g, '\\|')
  const g = (r.err ? `ERROR: ${r.err}` : r.got).replace(/\n/g, ' ⏎ ').replace(/\|/g, '\\|')
  md += `| ${r.name.slice(0, 2)} | ${r.name.slice(3)} | ${(r.cer * 100).toFixed(1)}% | \`${e}\` → \`${g}\` |\n`
}
const reportPath = join(BENCH, 'report.md')
writeFileSync(reportPath, md)
console.log(`\nSUMMARY: ${exactN}/20 exact · ${good}/20 ≤5% CER · avg CER ${(avgCer * 100).toFixed(1)}%`)
console.log('Report written to', reportPath)
