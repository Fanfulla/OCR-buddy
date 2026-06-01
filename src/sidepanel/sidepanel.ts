// Side panel — durable result UI with explicit states (idle / busy / result /
// error). Listens for OCR status/result broadcasts; renders the captured crop
// above the extracted text, flagging low-confidence words. The busy state shows
// a result skeleton + a per-stage progress bar; presentation only — the OCR
// logic and message protocol are untouched.

import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/vs2015.css'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import {
  LOW_CONFIDENCE,
  type CaptureMode,
  type DocBlock,
  type Message,
  type OcrResult,
  type OcrStage,
  type PermissionGranted,
  type StartSelection,
} from '../shared/messages'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const backendEl = $('backend')
const spinnerEl = $('spinner')
const busyLabel = $('busy-label')
const progressFill = $('progress-fill')
const busySkeleton = $('busy-skeleton')
const selectingNote = $('selecting-note')
const cropEl = $<HTMLImageElement>('crop')
const textEl = $('text')
const emptyNote = $('empty-note')
const uncertainSummary = $('uncertain-summary')
const uncertainCount = $('uncertain-count')
const errorMsg = $('error-msg')
const seg = document.querySelector<HTMLElement>('.seg')!
const segProse = $<HTMLButtonElement>('seg-prose')
const segCode = $<HTMLButtonElement>('seg-code')
const copyBtn = $<HTMLButtonElement>('copy')
const modeDesc = $('mode-desc')
const modeBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.mode-btn'))
let captureMode: CaptureMode = 'quick'
const MODE_DESC: Record<CaptureMode, string> = {
  quick: 'Quick OCR — code, prose, or any text.',
  document: 'Document — layout, columns, tables & equations.',
  formula: 'Formula — one equation → LaTeX, rendered beside the crop to verify.',
}
for (const btn of modeBtns) {
  btn.addEventListener('click', () => {
    captureMode = (btn.dataset.mode as CaptureMode) ?? 'quick'
    for (const b of modeBtns) {
      const on = b === btn
      b.classList.toggle('is-active', on)
      b.setAttribute('aria-checked', String(on))
    }
    modeDesc.textContent = MODE_DESC[captureMode]
  })
}

type State = 'idle' | 'busy' | 'result' | 'error' | 'permission'
const STATES: State[] = ['idle', 'busy', 'result', 'error', 'permission']
const setState = (s: State) => {
  for (const name of STATES) $(`state-${name}`).hidden = name !== s
}

const permOrigin = $('perm-origin')
const permWhy = $('perm-why')
const permEnable = $<HTMLButtonElement>('perm-enable')
const permDismiss = $<HTMLButtonElement>('perm-dismiss')
let needOrigin = ''

let lastResult: OcrResult | null = null
let codeMode = false

// Per-stage label + progress %. `selecting` waits on the user (no spinner, no
// skeleton — we show the drag hint instead).
interface StageView {
  label: string
  pct: number
  spin: boolean
  selecting?: boolean
}
const STAGE: Record<Exclude<OcrStage, 'error'>, StageView> = {
  selecting: { label: 'Drag over the text on the page…', pct: 6, spin: false, selecting: true },
  capturing: { label: 'Capturing region…', pct: 22, spin: true },
  preprocessing: { label: 'Preprocessing image…', pct: 40, spin: true },
  'loading-model': { label: 'Loading OCR model…', pct: 58, spin: true },
  detecting: { label: 'Detecting text…', pct: 76, spin: true },
  recognizing: { label: 'Recognizing text…', pct: 92, spin: true },
  done: { label: 'Done.', pct: 100, spin: false },
}

function showStage(stage: Exclude<OcrStage, 'error'>, progress?: number) {
  const v = STAGE[stage] ?? { label: stage, pct: 50, spin: true }
  busyLabel.textContent = v.label
  // Model download reports 0..1 — let it drive the bar within the loading band.
  const pct = stage === 'loading-model' && progress != null ? 50 + Math.round(progress * 20) : v.pct
  progressFill.style.width = `${pct}%`
  spinnerEl.hidden = !v.spin
  selectingNote.hidden = !v.selecting
  busySkeleton.hidden = !!v.selecting
  setState('busy')
}

function startSelection() {
  chrome.runtime.sendMessage({ type: 'START_SELECTION', mode: captureMode } satisfies StartSelection)
  busyLabel.textContent = 'Starting…'
  progressFill.style.width = '8%'
  spinnerEl.hidden = false
  selectingNote.hidden = true
  busySkeleton.hidden = false
  setState('busy')
}

for (const id of ['select-btn', 'new-capture', 'retry-btn']) {
  $<HTMLButtonElement>(id).addEventListener('click', startSelection)
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type === 'OCR_STATUS') {
    if (msg.stage === 'error') {
      errorMsg.textContent = msg.message ?? 'Something went wrong.'
      setState('error')
    } else if (msg.stage !== 'done') {
      showStage(msg.stage, msg.progress)
    }
  } else if (msg.type === 'NEED_PERMISSION') {
    needOrigin = msg.origin
    // Be honest about scope: with a known origin we grant just that site; without
    // one (page not ready) we have to request all sites.
    permOrigin.textContent = msg.origin || 'all sites'
    permWhy.hidden = true
    setState('permission')
  } else if (msg.type === 'OCR_RESULT') {
    renderResult(msg)
  }
  return false
})

permEnable.addEventListener('click', async () => {
  // Must run in a user gesture (this click) — the side panel is an extension page.
  const origins = needOrigin ? [`${needOrigin}/*`] : ['<all_urls>']
  const granted = await chrome.permissions.request({ origins })
  if (granted) {
    chrome.runtime.sendMessage({ type: 'PERMISSION_GRANTED' } satisfies PermissionGranted)
    busyLabel.textContent = 'Capturing region…'
    progressFill.style.width = '22%'
    spinnerEl.hidden = false
    selectingNote.hidden = true
    busySkeleton.hidden = false
    setState('busy')
  } else {
    permWhy.hidden = false // calm explanation, no alarmism
  }
})

permDismiss.addEventListener('click', () => {
  permWhy.hidden = false
})

function setBackendBadge(backend: 'webgpu' | 'wasm') {
  backendEl.textContent = backend === 'wasm' ? 'WASM' : 'WebGPU'
  backendEl.dataset.backend = backend
  backendEl.hidden = false
}

// Show the badge from the start, reflecting the device's capability; the result
// later confirms which backend actually ran.
async function initBadge() {
  let backend: 'webgpu' | 'wasm' = 'wasm'
  try {
    const gpu = (navigator as unknown as { gpu?: GPU }).gpu
    if (gpu && (await gpu.requestAdapter())) backend = 'webgpu'
  } catch {
    /* no WebGPU → WASM */
  }
  setBackendBadge(backend)
}
void initBadge()

function renderResult(r: OcrResult) {
  lastResult = r
  cropEl.src = r.imageDataUrl
  setBackendBadge(r.backend)
  emptyNote.hidden = !r.empty
  // Only quick mode has the Prose/Code split; document & formula don't.
  seg.hidden = r.mode !== 'quick'
  renderText()
  setState('result')
}

/** Code mode → syntax-highlighted codeText (read-only). Prose → editable, with
 *  per-word confidence underlines + a low-confidence summary. */
function renderText() {
  if (!lastResult) return
  textEl.replaceChildren()

  if (lastResult.mode === 'document') {
    textEl.classList.remove('hljs')
    textEl.classList.add('doc')
    textEl.contentEditable = 'false'
    renderDocBlocks(lastResult.docBlocks ?? [])
    uncertainSummary.hidden = true
    return
  }

  if (lastResult.mode === 'formula') {
    textEl.classList.remove('hljs')
    textEl.classList.add('doc')
    textEl.contentEditable = 'false'
    renderFormula(lastResult.latex ?? '', lastResult.latexOk ?? false)
    uncertainSummary.hidden = true
    return
  }
  textEl.classList.remove('doc')

  if (codeMode) {
    // hljs auto-detects the language and escapes the input, so innerHTML is safe.
    textEl.classList.add('hljs')
    textEl.contentEditable = 'false'
    textEl.innerHTML = hljs.highlightAuto(lastResult.codeText).value
    uncertainSummary.hidden = true
    return
  }
  textEl.classList.remove('hljs')
  textEl.contentEditable = 'true'

  // Prose: per-word spans (confidence underlines), with line breaks taken from the
  // engine's line grouping (w.line) — exactly where the source text wraps.
  let prevLine = -1
  let lowCount = 0
  for (const w of lastResult.words) {
    if (prevLine !== -1 && w.line !== prevLine) {
      textEl.appendChild(document.createTextNode('\n'))
    }
    const span = document.createElement('span')
    span.textContent = w.text
    if (w.confidence < LOW_CONFIDENCE) {
      span.className = 'uncertain'
      lowCount++
    }
    span.title = `confidence ${(w.confidence * 100).toFixed(0)}%`
    textEl.appendChild(span)
    textEl.appendChild(document.createTextNode(' '))
    prevLine = w.line
  }

  if (lowCount > 0 && !lastResult.empty) {
    uncertainCount.textContent = `${lowCount} word${lowCount > 1 ? 's' : ''} flagged low-confidence — verify against the source above`
    uncertainSummary.hidden = false
  } else {
    uncertainSummary.hidden = true
  }
}

/** Render document-mode blocks: text-like blocks as semantic elements, tables as
 *  real tables, and each equation as KaTeX shown BESIDE its source crop so the
 *  user can verify the transcription. KaTeX render failure → abstain to the image
 *  (we never present invented LaTeX as if it were read). */
function renderDocBlocks(blocks: DocBlock[]) {
  const frag = document.createDocumentFragment()
  for (const b of blocks) {
    if (b.kind === 'heading') {
      const h = document.createElement('h2')
      h.className = 'doc-h'
      h.textContent = b.text
      frag.appendChild(h)
    } else if (b.kind === 'caption') {
      const c = document.createElement('p')
      c.className = 'doc-cap'
      c.textContent = b.text
      frag.appendChild(c)
    } else if (b.kind === 'paragraph') {
      const p = document.createElement('p')
      p.className = 'doc-p'
      p.textContent = b.text
      frag.appendChild(p)
    } else if (b.kind === 'figure') {
      const f = document.createElement('div')
      f.className = 'doc-placeholder'
      f.textContent = 'Figure'
      frag.appendChild(f)
    } else if (b.kind === 'table') {
      frag.appendChild(renderMarkdownTable(b.markdown))
    } else if (b.kind === 'equation') {
      frag.appendChild(renderEquation(b))
    }
  }
  textEl.replaceChildren(frag)
}

function renderMarkdownTable(markdown: string): HTMLElement {
  const rows = markdown
    .trim()
    .split('\n')
    .map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
  const table = document.createElement('table')
  table.className = 'doc-table'
  rows.forEach((cells, i) => {
    // Row 1 is the markdown separator (---) — skip it.
    if (i === 1 && cells.every((c) => /^-+$/.test(c))) return
    const tr = document.createElement('tr')
    for (const cell of cells) {
      const el = document.createElement(i === 0 ? 'th' : 'td')
      el.textContent = cell.replace(/\\\|/g, '|')
      tr.appendChild(el)
    }
    table.appendChild(tr)
  })
  return table
}

function renderEquation(b: Extract<DocBlock, { kind: 'equation' }>): HTMLElement {
  const fig = document.createElement('figure')
  fig.className = 'doc-eq'

  let rendered: string | null = null
  if (b.ok && b.latex) {
    try {
      rendered = katex.renderToString(b.latex, { displayMode: true, throwOnError: true })
    } catch {
      rendered = null // unparseable LaTeX → abstain to the image
    }
  }

  const crop = document.createElement('img')
  crop.className = 'doc-eq-crop'
  crop.src = b.cropDataUrl
  crop.alt = 'source equation'

  const hint = document.createElement('figcaption')
  hint.className = 'doc-eq-hint'

  if (rendered) {
    const out = document.createElement('div')
    out.className = 'doc-eq-render'
    out.innerHTML = rendered // KaTeX output is sanitized HTML
    fig.append(out, crop)
    hint.textContent = 'Rendered from the source above — verify they match.'
    fig.dataset.ok = 'true'
  } else {
    fig.append(crop)
    hint.textContent = 'Could not transcribe — shown as image (nothing invented).'
    fig.dataset.ok = 'false'
  }
  fig.appendChild(hint)
  return fig
}

/** Formula mode: render the LaTeX with KaTeX in the text area; the source crop is
 *  already shown above (Source · captured region), giving the side-by-side check.
 *  Render failure or a degenerate decode → abstain (the crop above is the answer). */
function renderFormula(latex: string, ok: boolean) {
  textEl.replaceChildren()
  let html: string | null = null
  if (ok && latex) {
    try {
      html = katex.renderToString(latex, { displayMode: true, throwOnError: true })
    } catch {
      html = null
    }
  }
  const hint = document.createElement('p')
  hint.className = 'doc-eq-hint'
  if (html) {
    const out = document.createElement('div')
    out.className = 'doc-eq-render'
    out.innerHTML = html // KaTeX output is sanitized HTML
    hint.textContent = 'Rendered from the source above — verify it matches before trusting it.'
    textEl.append(out, hint)
  } else {
    hint.textContent = 'Could not transcribe this formula — use the source image above (nothing invented).'
    textEl.append(hint)
  }
}

function setMode(code: boolean) {
  codeMode = code
  seg.dataset.mode = code ? 'code' : 'prose'
  segCode.classList.toggle('is-active', code)
  segProse.classList.toggle('is-active', !code)
  segCode.setAttribute('aria-selected', String(code))
  segProse.setAttribute('aria-selected', String(!code))
  renderText()
}
segProse.addEventListener('click', () => setMode(false))
segCode.addEventListener('click', () => setMode(true))

const COPY_ICON = '<rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path>'
const CHECK_ICON = '<polyline points="20 6 9 17 4 12"></polyline>'

copyBtn.addEventListener('click', async () => {
  // Copy the source, not the rendered DOM: Markdown for documents, raw LaTeX for
  // formulas, plain text otherwise.
  const payload =
    lastResult?.mode === 'document'
      ? (lastResult.docText ?? '')
      : lastResult?.mode === 'formula'
        ? (lastResult.latex ?? '')
        : (textEl.textContent ?? '')
  await navigator.clipboard.writeText(payload)
  const label = copyBtn.querySelector('.copy-label')!
  const icon = copyBtn.querySelector('.ic-copy')!
  label.textContent = 'Copied'
  icon.innerHTML = CHECK_ICON
  copyBtn.classList.add('is-done')
  setTimeout(() => {
    label.textContent = 'Copy'
    icon.innerHTML = COPY_ICON
    copyBtn.classList.remove('is-done')
  }, 1300)
})

// Show the platform-correct modifier in the shortcut hint (⌘ on macOS). The
// binding itself (Ctrl+Shift+Y / Command+Shift+Y) lives in the manifest command.
const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent)
if (isMac) {
  const modEl = document.getElementById('kbd-mod')
  if (modEl) modEl.textContent = '⌘'
}

setMode(false)
setState('idle')
