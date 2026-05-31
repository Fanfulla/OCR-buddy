// Side panel — durable result UI. Listens for OCR status/result broadcasts and
// renders the captured crop beside the extracted text, flagging low-confidence
// words. Survives tab navigation (unlike a popup).

import { LOW_CONFIDENCE, type Message, type OcrResult } from '../shared/messages'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const statusEl = $('status')
const resultEl = $('result')
const cropEl = $<HTMLImageElement>('crop')
const textEl = $('text')
const emptyNote = $('empty-note')
const backendEl = $('backend')
const copyBtn = $<HTMLButtonElement>('copy')
const codeModeEl = $<HTMLInputElement>('code-mode')

let lastResult: OcrResult | null = null

const STAGE_LABEL: Record<string, string> = {
  capturing: 'Capturing region…',
  preprocessing: 'Preprocessing…',
  'loading-model': 'Loading OCR model…',
  detecting: 'Detecting text…',
  recognizing: 'Recognizing text…',
  done: 'Done.',
  error: 'Error.',
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type === 'OCR_STATUS') {
    statusEl.textContent =
      (STAGE_LABEL[msg.stage] ?? msg.stage) + (msg.message ? ` ${msg.message}` : '')
    statusEl.hidden = false
  } else if (msg.type === 'OCR_RESULT') {
    renderResult(msg)
  }
  return false
})

function renderResult(r: OcrResult) {
  lastResult = r
  statusEl.hidden = true
  resultEl.hidden = false
  cropEl.src = r.imageDataUrl

  backendEl.textContent = r.backend
  backendEl.hidden = false

  emptyNote.hidden = !r.empty
  renderText()
}

/** Code mode → raw codeText (whitespace preserved). Prose → per-word confidence. */
function renderText() {
  if (!lastResult) return
  textEl.replaceChildren()

  if (codeModeEl.checked) {
    textEl.textContent = lastResult.codeText
    return
  }
  for (const w of lastResult.words) {
    const span = document.createElement('span')
    span.textContent = w.text + ' '
    if (w.confidence < LOW_CONFIDENCE) span.className = 'uncertain'
    span.title = `confidence ${(w.confidence * 100).toFixed(0)}%`
    textEl.appendChild(span)
  }
}

codeModeEl.addEventListener('change', renderText)

copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(textEl.textContent ?? '')
  copyBtn.textContent = 'Copied'
  setTimeout(() => (copyBtn.textContent = 'Copy'), 1200)
})
