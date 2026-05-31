// Side panel — durable result UI with explicit states (idle / busy / result /
// error). Listens for OCR status/result broadcasts; renders the captured crop
// beside the extracted text, flagging low-confidence words.

import { LOW_CONFIDENCE, type Message, type OcrResult, type StartSelection } from '../shared/messages'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const backendEl = $('backend')
const spinnerEl = $('spinner')
const busyLabel = $('busy-label')
const cropEl = $<HTMLImageElement>('crop')
const textEl = $('text')
const emptyNote = $('empty-note')
const errorMsg = $('error-msg')
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

const STAGE_LABEL: Record<string, string> = {
  selecting: 'Drag on the page to select a region…',
  capturing: 'Capturing region…',
  preprocessing: 'Preprocessing…',
  'loading-model': 'Loading OCR model…',
  detecting: 'Detecting text…',
  recognizing: 'Recognizing text…',
  done: 'Done.',
}

function startSelection() {
  chrome.runtime.sendMessage({ type: 'START_SELECTION' } satisfies StartSelection)
  busyLabel.textContent = 'Starting…'
  spinnerEl.hidden = false
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
      busyLabel.textContent = STAGE_LABEL[msg.stage] ?? msg.stage
      spinnerEl.hidden = msg.stage === 'selecting' // no spinner while waiting on the user
      setState('busy')
    }
  } else if (msg.type === 'OCR_RESULT') {
    renderResult(msg)
  }
  return false
})

function renderResult(r: OcrResult) {
  lastResult = r
  cropEl.src = r.imageDataUrl
  backendEl.textContent = r.backend
  backendEl.hidden = false
  emptyNote.hidden = !r.empty
  renderText()
  setState('result')
}

/** Code mode → raw codeText (whitespace preserved). Prose → per-word confidence. */
function renderText() {
  if (!lastResult) return
  textEl.replaceChildren()

  if (codeMode) {
    textEl.textContent = lastResult.codeText
    return
  }
  // Prose: per-word spans (confidence underlines), with line breaks inferred from
  // vertical jumps between consecutive word boxes.
  let prevY: number | null = null
  let prevH = 0
  for (const w of lastResult.words) {
    if (prevY !== null && w.box.y > prevY + prevH * 0.5) {
      textEl.appendChild(document.createTextNode('\n'))
    }
    const span = document.createElement('span')
    span.textContent = w.text
    if (w.confidence < LOW_CONFIDENCE) span.className = 'uncertain'
    span.title = `confidence ${(w.confidence * 100).toFixed(0)}%`
    textEl.appendChild(span)
    textEl.appendChild(document.createTextNode(' '))
    prevY = w.box.y
    prevH = w.box.height
  }
}

function setMode(code: boolean) {
  codeMode = code
  segCode.classList.toggle('is-active', code)
  segProse.classList.toggle('is-active', !code)
  renderText()
}
segProse.addEventListener('click', () => setMode(false))
segCode.addEventListener('click', () => setMode(true))

copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(textEl.textContent ?? '')
  copyBtn.textContent = 'Copied'
  setTimeout(() => (copyBtn.textContent = 'Copy'), 1200)
})

setState('idle')
