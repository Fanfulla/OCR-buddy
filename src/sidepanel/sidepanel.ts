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
  type Reprocess,
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
const idlePick = $('mode-pick-idle')
const resultPick = $('mode-pick-result')
let captureMode: CaptureMode = 'quick'
const MODE_DESC: Record<CaptureMode, string> = {
  quick: 'Text/Code — code, prose, or any text.',
  formula: 'Formula — one equation → LaTeX, rendered beside the crop to verify.',
  table: 'Table — one table → Markdown grid (works on borderless tables too).',
}

/** Highlight the button matching `mode` within a picker, and roll the roving
 *  tabindex onto it so Tab lands on the active option (arrow keys move from there). */
function syncPicker(pick: HTMLElement, mode: CaptureMode) {
  for (const b of pick.querySelectorAll<HTMLButtonElement>('.mode-btn')) {
    const on = b.dataset.mode === mode
    b.classList.toggle('is-active', on)
    b.setAttribute('aria-checked', String(on))
    b.tabIndex = on ? 0 : -1
  }
}

// Persist the last-used capture mode + Prose/Code view across panel opens.
const PREFS_KEY = 'sidepanel.prefs'
function savePrefs() {
  void chrome.storage.local.set({ [PREFS_KEY]: { captureMode, codeMode } })
}
async function restorePrefs() {
  try {
    const got = await chrome.storage.local.get(PREFS_KEY)
    const p = got[PREFS_KEY] as { captureMode?: CaptureMode; codeMode?: boolean } | undefined
    if (p?.captureMode === 'quick' || p?.captureMode === 'formula' || p?.captureMode === 'table') {
      captureMode = p.captureMode
    }
    if (typeof p?.codeMode === 'boolean') codeMode = p.codeMode
  } catch {
    /* storage unavailable → keep defaults */
  }
  syncPicker(idlePick, captureMode)
  modeDesc.textContent = MODE_DESC[captureMode]
  setMode(codeMode)
}

// Idle picker: choose the mode for the NEXT capture.
for (const b of idlePick.querySelectorAll<HTMLButtonElement>('.mode-btn')) {
  b.addEventListener('click', () => {
    captureMode = (b.dataset.mode as CaptureMode) ?? 'quick'
    syncPicker(idlePick, captureMode)
    modeDesc.textContent = MODE_DESC[captureMode]
    savePrefs()
  })
}

// Result picker: reinterpret the CURRENT crop in another mode — no re-selection.
for (const b of resultPick.querySelectorAll<HTMLButtonElement>('.mode-btn')) {
  b.addEventListener('click', () => {
    const mode = (b.dataset.mode as CaptureMode) ?? 'quick'
    if (!lastResult || mode === lastResult.mode) return
    captureMode = mode
    syncPicker(resultPick, mode)
    savePrefs()
    chrome.runtime.sendMessage({
      type: 'REPROCESS',
      imageDataUrl: lastResult.imageDataUrl,
      mode,
    } satisfies Reprocess)
    busyLabel.textContent = 'Re-reading region…'
    progressFill.style.width = '40%'
    spinnerEl.hidden = false
    selectingNote.hidden = true
    busySkeleton.hidden = false
    setState('busy')
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
  let granted = false
  try {
    granted = await chrome.permissions.request({ origins })
  } catch (err) {
    // A managed/policy browser can REJECT host-permission requests outright (the
    // prompt never appears). Don't fail silently — explain and offer the activeTab
    // path, which needs no host grant.
    permWhy.hidden = false
    permWhy.textContent =
      `Your browser blocked the site-permission request (${err instanceof Error ? err.message : String(err)}). ` +
      'You can still capture the tab you opened the panel from: press Ctrl+Shift+Y on the page, ' +
      'or click the OCR Buddy toolbar icon there.'
    return
  }
  if (granted) {
    chrome.runtime.sendMessage({ type: 'PERMISSION_GRANTED' } satisfies PermissionGranted)
    busyLabel.textContent = 'Capturing region…'
    progressFill.style.width = '22%'
    spinnerEl.hidden = false
    selectingNote.hidden = true
    busySkeleton.hidden = false
    setState('busy')
  } else {
    // Denied (or silently refused by policy): calm explanation, no alarmism.
    permWhy.hidden = false
  }
})

permDismiss.addEventListener('click', () => {
  permWhy.hidden = false
})

function setBackendBadge(backend: 'webgpu' | 'wasm') {
  backendEl.textContent = backend === 'wasm' ? 'WASM' : 'WebGPU'
  backendEl.dataset.backend = backend
  // The amber WASM badge reads like a warning; clarify it's just the slower path.
  backendEl.title =
    backend === 'wasm'
      ? 'Running on WebAssembly — slower than WebGPU, identical results'
      : 'Running on WebGPU — hardware accelerated'
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
  // Only quick mode has the Prose/Code split; formula & table don't.
  seg.hidden = r.mode !== 'quick'
  syncPicker(resultPick, r.mode)
  // Label Copy by what it actually copies (raw LaTeX / Markdown / text).
  copyBtn.querySelector('.copy-label')!.textContent = copyLabelFor(r.mode)
  renderText()
  setState('result')
}

/** Code mode → syntax-highlighted codeText (read-only). Prose → editable, with
 *  per-word confidence underlines + a low-confidence summary. */
function renderText() {
  if (!lastResult) return
  textEl.replaceChildren()

  if (lastResult.mode === 'table') {
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

/** Render Table-mode blocks: the reconstructed grid as a real table, or a plain
 *  paragraph when the crop wasn't grid-like. */
function renderDocBlocks(blocks: DocBlock[]) {
  const frag = document.createDocumentFragment()
  for (const b of blocks) {
    if (b.kind === 'table') {
      frag.appendChild(renderMarkdownTable(b.markdown))
    } else {
      const p = document.createElement('p')
      p.className = 'doc-p'
      p.textContent = b.text
      frag.appendChild(p)
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
  segCode.tabIndex = code ? 0 : -1
  segProse.tabIndex = code ? -1 : 0
  renderText()
  savePrefs()
}
segProse.addEventListener('click', () => setMode(false))
segCode.addEventListener('click', () => setMode(true))

// Roving-tabindex arrow-key navigation for the ARIA radiogroups + tablist, so the
// keyboard contract their roles promise actually works. `activateOnMove` makes
// selection follow focus (cheap idle picker + Prose/Code seg); the result picker
// passes false — there, arrows only move focus and Enter/Space (native button
// behaviour) commits, because activating fires a real OCR reprocess.
function wireRovingKeys(container: HTMLElement, activateOnMove: boolean) {
  container.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
    const items = [...container.querySelectorAll<HTMLButtonElement>('button')]
    const cur = items.indexOf(document.activeElement as HTMLButtonElement)
    if (cur < 0) return
    e.preventDefault()
    let next = cur
    if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (cur + 1) % items.length
    else next = (cur - 1 + items.length) % items.length
    items[next].focus()
    if (activateOnMove) items[next].click()
  })
}
wireRovingKeys(idlePick, true)
wireRovingKeys(resultPick, false)
wireRovingKeys(seg, true)

const COPY_ICON = '<rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path>'
const CHECK_ICON = '<polyline points="20 6 9 17 4 12"></polyline>'

/** The resting Copy label, named for what the current mode actually copies. */
const copyLabelFor = (mode?: CaptureMode) =>
  mode === 'formula' ? 'Copy LaTeX' : mode === 'table' ? 'Copy Markdown' : 'Copy text'

copyBtn.addEventListener('click', async () => {
  // Copy the source, not the rendered DOM: Markdown for documents, raw LaTeX for
  // formulas, plain text otherwise.
  const payload =
    lastResult?.mode === 'table'
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
    label.textContent = copyLabelFor(lastResult?.mode)
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

void restorePrefs()
setState('idle')
