// Side panel — durable result UI with explicit states (idle / busy / result /
// error). Listens for OCR status/result broadcasts; renders the captured crop
// above the extracted text, flagging low-confidence words. The busy state shows
// a result skeleton + a per-stage progress bar; presentation only — the OCR
// logic and message protocol are untouched.

import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/vs2015.css'
import { LOW_CONFIDENCE, type Message, type OcrResult, type OcrStage, type StartSelection } from '../shared/messages'

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

type State = 'idle' | 'busy' | 'result' | 'error'
const STATES: State[] = ['idle', 'busy', 'result', 'error']
const setState = (s: State) => {
  for (const name of STATES) $(`state-${name}`).hidden = name !== s
}

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
  chrome.runtime.sendMessage({ type: 'START_SELECTION' } satisfies StartSelection)
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
  } else if (msg.type === 'OCR_RESULT') {
    renderResult(msg)
  }
  return false
})

function renderResult(r: OcrResult) {
  lastResult = r
  cropEl.src = r.imageDataUrl
  backendEl.textContent = r.backend === 'wasm' ? 'WASM' : 'WebGPU'
  backendEl.dataset.backend = r.backend
  backendEl.hidden = false
  emptyNote.hidden = !r.empty
  renderText()
  setState('result')
}

/** Code mode → syntax-highlighted codeText (read-only). Prose → editable, with
 *  per-word confidence underlines + a low-confidence summary. */
function renderText() {
  if (!lastResult) return
  textEl.replaceChildren()

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
  await navigator.clipboard.writeText(textEl.textContent ?? '')
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
