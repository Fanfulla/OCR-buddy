// Side panel — durable result UI with explicit states (idle / busy / result /
// error). Listens for OCR status/result broadcasts; renders the captured crop
// above the extracted text, flagging low-confidence words. The busy state shows
// a result skeleton + a per-stage progress bar; presentation only — the OCR
// logic and message protocol are untouched.

import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/vs2015.css'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { htmlToMarkdown } from './html-to-markdown'
import { markRated, openReviewPage, recordSuccessAndMaybeNudge, renderStars } from './review'
import { openShortcutSettings, shortcutBrowserName } from '../shared/browser-compat'
import {
  LOW_CONFIDENCE,
  PREFS_KEY,
  type CaptureMode,
  type DocBlock,
  type Message,
  type OcrResult,
  type OcrStage,
  type PanelPrefs,
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
const resultNote = $<HTMLParagraphElement>('result-note')
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
const langSelect = $<HTMLSelectElement>('lang-select')
const langNote = $('lang-note')
let captureMode: CaptureMode = 'quick'
let lang = 'latin'
let iconAction: 'panel' | 'select' = 'panel'
let autoCopy = false
let prefsLoaded = false
const iconActionSelect = $<HTMLSelectElement>('icon-action')
const autoCopyBox = $<HTMLInputElement>('auto-copy')
const clipboardStatus = $('clipboard-status')
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
// (PREFS_KEY is shared: the SW reads it for the keyboard-shortcut mode.)
function savePrefs() {
  if (!prefsLoaded) return
  void chrome.storage.local.set({
    [PREFS_KEY]: { captureMode, codeMode, lang, history: historyEnabled, iconAction, autoCopy } satisfies PanelPrefs,
  })
}
async function restorePrefs() {
  try {
    const got = await chrome.storage.local.get(PREFS_KEY)
    const p = got[PREFS_KEY] as PanelPrefs | undefined
    if (p?.captureMode === 'quick' || p?.captureMode === 'formula' || p?.captureMode === 'table') {
      captureMode = p.captureMode
    }
    if (typeof p?.codeMode === 'boolean') codeMode = p.codeMode
    if (typeof p?.history === 'boolean') historyEnabled = p.history
    iconAction = p?.iconAction === 'select' ? 'select' : 'panel'
    autoCopy = p?.autoCopy === true && await chrome.permissions.contains({ permissions: ['clipboardWrite'] })
    // Only restore a pack the select actually offers (stale prefs → default).
    if (p?.lang && [...langSelect.options].some((o) => o.value === p.lang)) lang = p.lang
  } catch {
    /* storage unavailable → keep defaults */
  }
  syncPicker(idlePick, captureMode)
  modeDesc.textContent = MODE_DESC[captureMode]
  syncLang()
  setMode(codeMode)
  iconActionSelect.value = iconAction
  autoCopyBox.checked = autoCopy
  prefsLoaded = true
}

iconActionSelect.addEventListener('change', () => {
  iconAction = iconActionSelect.value === 'select' ? 'select' : 'panel'
  savePrefs()
})
autoCopyBox.addEventListener('change', async () => {
  autoCopyBox.disabled = true
  try {
    if (autoCopyBox.checked) {
      autoCopy = await chrome.permissions.request({ permissions: ['clipboardWrite'] })
      clipboardStatus.textContent = autoCopy ? 'Automatic copy enabled.' : 'Automatic copy needs clipboard write access.'
    } else {
      autoCopy = false
      await chrome.permissions.remove({ permissions: ['clipboardWrite'] })
      clipboardStatus.textContent = 'Automatic copy disabled.'
    }
  } catch {
    autoCopy = false
    clipboardStatus.textContent = 'Clipboard access was blocked. Manual Copy is still available.'
  }
  autoCopyBox.checked = autoCopy
  autoCopyBox.disabled = false
  savePrefs()
})
chrome.permissions.onRemoved.addListener((p) => {
  if (p.permissions?.includes('clipboardWrite')) {
    autoCopy = false
    autoCopyBox.checked = false
    savePrefs()
  }
})
$('shortcuts-btn').addEventListener('click', () => {
  void openShortcutSettings()
})
$('updates-btn').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('updates.html') })
})
void chrome.commands.getAll().then((commands) => {
  $('shortcut-list').textContent = commands
    .filter((c) => c.name && !c.name.startsWith('_'))
    .map((c) => `${c.description?.replace('OCR Buddy: ', '')}: ${c.shortcut || 'Not assigned'}`).join(' · ')
  for (const [name, id] of [['start-capture', 'select-btn'], ['capture-viewport', 'capture-viewport'], ['capture-fullpage', 'capture-fullpage']]) {
    const shortcut = commands.find((c) => c.name === name)?.shortcut
    if (shortcut) $(id).title = `${$(id).textContent} (${shortcut})`
  }
}).catch(() => { $('shortcut-list').textContent = `Configure shortcuts in ${shortcutBrowserName}.` })

/** Reflect the selected pack in the UI; the download note only applies to
 *  non-bundled packs. */
function syncLang() {
  langSelect.value = lang
  langNote.hidden = lang === 'latin'
}
langSelect.addEventListener('change', () => {
  lang = langSelect.value
  syncLang()
  savePrefs()
})

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

type State = 'idle' | 'busy' | 'result' | 'error' | 'permission' | 'restricted' | 'history' | 'markdown' | 'pdf'
const STATES: State[] = ['idle', 'busy', 'result', 'error', 'permission', 'restricted', 'history', 'markdown', 'pdf']
let currentState: State = 'idle'
let pdfController: AbortController | null = null
let selectionPending = false
const setState = (s: State) => {
  currentState = s
  if (s !== 'busy') selectionPending = false
  for (const name of STATES) $(`state-${name}`).hidden = name !== s
  for (const b of document.querySelectorAll<HTMLButtonElement>('.capture-toolbar button, #home-btn, #history-btn')) b.disabled = s === 'busy' || pdfController !== null
}

const permOrigin = $('perm-origin')
const permWhy = $('perm-why')
const permEnable = $<HTMLButtonElement>('perm-enable')
const permDismiss = $<HTMLButtonElement>('perm-dismiss')
let needOrigin = ''

const restrictedWhat = $('restricted-what')
$<HTMLButtonElement>('restricted-back').addEventListener('click', () => setState('idle'))

let lastResult: OcrResult | null = null
let codeMode = false
// User edits to the prose view (contentEditable). Captured on input so a
// Prose↔Code toggle doesn't silently discard them; reset on every new result.
let editedProse: string | null = null

textEl.addEventListener('input', () => {
  if (lastResult?.mode === 'quick' && !codeMode) editedProse = textEl.textContent
})

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
  selectionPending = stage === 'selecting'
  const v = STAGE[stage] ?? { label: stage, pct: 50, spin: true }
  // A 0..1 progress on loading-model means a language pack is downloading
  // (first use only — cached afterwards). Say so instead of the generic label.
  busyLabel.textContent =
    stage === 'loading-model' && progress != null
      ? `Downloading language pack… ${Math.round(progress * 100)}%`
      : v.label
  // Model download reports 0..1 — let it drive the bar within the loading band.
  const pct = stage === 'loading-model' && progress != null ? 50 + Math.round(progress * 20) : v.pct
  progressFill.style.width = `${pct}%`
  spinnerEl.hidden = !v.spin
  selectingNote.hidden = !v.selecting
  busySkeleton.hidden = !!v.selecting
  setState('busy')
}

function startSelection() {
  if (currentState === 'busy') return
  selectionPending = true
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

$('cancel-selection').addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'CANCEL_SELECTION' }).catch(() => {})
  setState(lastResult ? 'result' : 'idle')
})

async function activeTab(): Promise<{ id?: number; origin: string }> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    return { id: tab?.id, origin: tab?.url ? new URL(tab.url).origin : '' }
  } catch {
    return { id: undefined, origin: '' }
  }
}

function startBusy(label: string): void {
  selectionPending = false
  busyLabel.textContent = label
  progressFill.style.width = '8%'
  spinnerEl.hidden = false
  selectingNote.hidden = true
  busySkeleton.hidden = false
  setState('busy')
}

$<HTMLButtonElement>('capture-viewport').addEventListener('click', async () => {
  startBusy('Capturing viewport…')
  const { id, origin } = await activeTab()
  if (id === undefined) {
    errorMsg.textContent = 'No active tab to capture.'
    setState('error')
    return
  }
  // Empty origin (e.g. chrome:// pages) intentionally lets the SW fall back to
  // the all-sites permission prompt — same behaviour as the region-capture flow.
  chrome.runtime.sendMessage({ type: 'CAPTURE_VIEWPORT', tabId: id, mode: captureMode, origin })
})

$<HTMLButtonElement>('capture-fullpage').addEventListener('click', async () => {
  // Go busy synchronously first — setState('busy') hides the idle buttons so a
  // second click can't fire a duplicate full-page capture during the await below.
  startBusy('Capturing full page…')
  const { id, origin } = await activeTab()
  if (id === undefined) {
    errorMsg.textContent = 'No active tab to capture.'
    setState('error')
    return
  }
  chrome.runtime.sendMessage({ type: 'CAPTURE_FULLPAGE', tabId: id, origin })
})

// Page → Markdown: read the page DOM (no OCR) and convert it in this panel.
let lastMarkdown = ''
let lastMdTitle = ''
// Hybrid mode: the page payload is held while its readable images are OCR'd, then
// converted once the per-image text arrives (index-aligned with `pendingImages`).
let pendingPage: { html: string; title: string; url: string } | null = null
let pendingImages: import('../shared/messages').PageImage[] = []

$<HTMLButtonElement>('page-md').addEventListener('click', async () => {
  startBusy('Reading page…')
  const { id, origin } = await activeTab()
  if (id === undefined) {
    errorMsg.textContent = 'No active tab to read.'
    setState('error')
    return
  }
  chrome.runtime.sendMessage({ type: 'CONVERT_PAGE_MD', tabId: id, origin })
})

const mdPre = $('md-pre')
const mdTitle = $('md-title')

function renderMarkdown(html: string, title: string, url: string, ocrBySrc?: Map<string, string>): void {
  lastMarkdown = htmlToMarkdown(html, title, url, ocrBySrc)
  lastMdTitle = title || url
  mdTitle.textContent = lastMdTitle
  mdPre.textContent = lastMarkdown
  setState('markdown')
  void copyAutomatically(lastMarkdown)
}

$<HTMLButtonElement>('md-back').addEventListener('click', () => setState(lastResult ? 'result' : 'idle'))

$<HTMLButtonElement>('md-copy').addEventListener('click', async () => {
  await copyText(lastMarkdown)
})

$<HTMLButtonElement>('md-download').addEventListener('click', () => {
  const slug = (lastMdTitle || 'page').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page'
  const blob = new Blob([lastMarkdown], { type: 'text/markdown' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${slug}.md`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
})

chrome.runtime.onMessage.addListener((msg: Message, _sender, respond) => {
  if (msg.type === 'PANEL_READY') {
    respond({ ok: true, busy: currentState === 'busy' || pdfController !== null })
    return false
  }
  if (pdfController && (msg.type === 'OCR_STATUS' || msg.type === 'OCR_RESULT')) return false
  if (msg.type === 'SELECTION_CANCELLED') {
    if (currentState === 'busy' && (selectionPending || !selectingNote.hidden)) setState(lastResult ? 'result' : 'idle')
  } else if (msg.type === 'PAGE_HTML') {
    // No readable images → convert straight away. Otherwise OCR them first
    // (hybrid), then convert with captions once PAGE_IMAGES_OCR arrives.
    if (msg.images.length === 0) {
      renderMarkdown(msg.html, msg.title, msg.url)
    } else {
      pendingPage = { html: msg.html, title: msg.title, url: msg.url }
      pendingImages = msg.images
      busyLabel.textContent = `Reading text in ${msg.images.length} image${msg.images.length > 1 ? 's' : ''}…`
      chrome.runtime.sendMessage({ type: 'RUN_OCR_IMAGES', imageDataUrls: msg.images.map((i) => i.dataUrl) })
    }
  } else if (msg.type === 'PAGE_IMAGES_OCR') {
    if (!pendingPage) return false
    const ocrBySrc = new Map<string, string>()
    pendingImages.forEach((img, i) => {
      const t = msg.texts[i]
      if (t) ocrBySrc.set(img.src, t)
    })
    renderMarkdown(pendingPage.html, pendingPage.title, pendingPage.url, ocrBySrc)
    pendingPage = null
    pendingImages = []
  } else if (msg.type === 'OCR_STATUS') {
    if (msg.stage === 'error') {
      errorMsg.textContent = msg.message ?? 'Something went wrong.'
      setState('error')
    } else if (msg.stage !== 'done') {
      showStage(msg.stage, msg.progress)
      if (msg.message) busyLabel.textContent = msg.message
    }
  } else if (msg.type === 'NEED_PERMISSION') {
    needOrigin = msg.origin
    // Be honest about scope: with a known origin we grant just that site; without
    // one (page not ready) we have to request all sites.
    permOrigin.textContent = msg.origin || 'all sites'
    permWhy.hidden = true
    setState('permission')
  } else if (msg.type === 'RESTRICTED') {
    restrictedWhat.textContent = msg.reason
    setState('restricted')
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

function renderResult(r: OcrResult, save = true) {
  lastResult = r
  editedProse = null
  if (save) void saveToHistory(r)
  cropEl.src = r.imageDataUrl
  setBackendBadge(r.backend)
  emptyNote.hidden = !r.empty
  resultNote.textContent = r.note ?? ''
  resultNote.hidden = !r.note
  // Only quick mode has the Prose/Code split; formula & table don't.
  seg.hidden = r.mode !== 'quick'
  syncPicker(resultPick, r.mode)
  // Label Copy by what it actually copies (raw LaTeX / Markdown / text).
  copyBtn.querySelector('.copy-label')!.textContent = copyLabelFor(r.mode)
  renderText()
  setState('result')
  clipboardStatus.textContent = ''
  if (save && !r.empty && (r.mode !== 'formula' || textEl.querySelector('.doc-eq-render'))) void copyAutomatically(resultPayload())
  // Review nudge: only on a FRESH, non-empty capture — never on history restores
  // (save === false) and never after a poor read (empty).
  reviewNudge.hidden = true
  if (save && !r.empty) void maybeShowNudge()
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

  // The user edited this prose: render their text verbatim instead of rebuilding
  // from words (which would discard the edits). Confidence underlines no longer
  // map to the edited text, so they're dropped.
  if (editedProse !== null) {
    textEl.textContent = editedProse
    uncertainSummary.hidden = true
    return
  }

  // Merged/word-less quick result (full-page capture): no per-word boxes, so render
  // the plain text. Normal captures keep the per-word confidence spans below.
  if (lastResult.words.length === 0) {
    textEl.textContent = lastResult.text
    uncertainSummary.hidden = true
    return
  }

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

function resultPayload(): string {
  // Copy the source, not the rendered DOM: Markdown for documents, raw LaTeX for
  // formulas, plain text otherwise.
  return (
    lastResult?.mode === 'table'
      ? (lastResult.docText ?? '')
      : lastResult?.mode === 'formula'
        ? (lastResult.latex ?? '')
        : (textEl.innerText ?? ''))
}

async function copyText(payload: string): Promise<boolean> {
  if (!payload.trim()) return false
  try {
    await navigator.clipboard.writeText(payload)
    clipboardStatus.textContent = 'Copied to clipboard.'
    return true
  } catch {
    clipboardStatus.textContent = 'Could not copy. Select the text and copy it manually.'
    return false
  }
}

async function copyAutomatically(payload: string): Promise<void> {
  if (!autoCopy || !payload.trim()) return
  try {
    const result = await chrome.runtime.sendMessage({ type: 'COPY_TEXT', text: payload })
    clipboardStatus.textContent = result?.ok ? 'Copied to clipboard.' : 'Automatic copy failed. Click Copy to try again.'
  } catch {
    clipboardStatus.textContent = 'Automatic copy failed. Click Copy to try again.'
  }
}

copyBtn.addEventListener('click', async () => {
  if (!await copyText(resultPayload())) return
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

// ── History: recent captures, stored ONLY in chrome.storage.local ────────────
// Privacy: entries hold page screenshots, so there's an off switch and a clear
// button; nothing ever leaves the device.

interface HistEntry {
  ts: number
  result: OcrResult
}
const HIST_KEY = 'history.v1'
const HIST_MAX = 20
let historyEnabled = true

const histBtn = $<HTMLButtonElement>('history-btn')
const histList = $('hist-list')
const histEmpty = $('hist-empty')
const histEnabledBox = $<HTMLInputElement>('hist-enabled')
const histClear = $<HTMLButtonElement>('hist-clear')
const histSelectAll = $<HTMLInputElement>('hist-select-all')
const histCopy = $<HTMLButtonElement>('hist-copy')
const histExport = $<HTMLButtonElement>('hist-export')
let historyList: HistEntry[] = []
const selectedHistory = new Set<HistEntry>()

function updateHistorySelection(): void {
  const n = selectedHistory.size
  histCopy.disabled = histExport.disabled = n === 0
  histSelectAll.checked = historyList.length > 0 && n === historyList.length
  histSelectAll.indeterminate = n > 0 && n < historyList.length
  histSelectAll.disabled = historyList.length === 0
  $('hist-selection-count').textContent = `${n} selected · copied oldest first`
}

function selectedHistoryText(): string {
  return [...selectedHistory].sort((a, b) => a.ts - b.ts).map(({ result: r }) =>
    r.mode === 'formula' ? r.latex ?? '' : r.mode === 'table' ? r.docText ?? '' : r.text,
  ).join('\n\n---\n\n')
}
histSelectAll.addEventListener('change', () => {
  selectedHistory.clear()
  if (histSelectAll.checked) historyList.forEach((e) => selectedHistory.add(e))
  histList.querySelectorAll<HTMLInputElement>('.hist-select').forEach((c) => { c.checked = histSelectAll.checked })
  updateHistorySelection()
})
histCopy.addEventListener('click', () => void copyText(selectedHistoryText()))
histExport.addEventListener('click', () => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([selectedHistoryText()], { type: 'text/plain;charset=utf-8' }))
  a.download = 'ocr-buddy-captures.txt'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
})

async function loadHistory(): Promise<HistEntry[]> {
  try {
    const got = await chrome.storage.local.get(HIST_KEY)
    return (got[HIST_KEY] as HistEntry[] | undefined) ?? []
  } catch {
    return []
  }
}

async function saveToHistory(r: OcrResult): Promise<void> {
  if (!historyEnabled) return
  try {
    let list = await loadHistory()
    // Reinterpreting the same crop ("Read as") updates the entry, not adds one.
    if (list[0]?.result.imageDataUrl === r.imageDataUrl) list = list.slice(1)
    list.unshift({ ts: Date.now(), result: r })
    await chrome.storage.local.set({ [HIST_KEY]: list.slice(0, HIST_MAX) })
  } catch {
    /* storage full/unavailable — history is best-effort */
  }
}

/** One-line preview of what an entry produced. */
function histSnippet(r: OcrResult): string {
  const s = (r.mode === 'formula' ? r.latex : r.mode === 'table' ? r.docText : r.text) ?? ''
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 90 ? t.slice(0, 90) + '…' : t || '(empty)'
}

async function openHistory(): Promise<void> {
  const list = await loadHistory()
  historyList = list
  selectedHistory.clear()
  updateHistorySelection()
  histEnabledBox.checked = historyEnabled
  histEmpty.hidden = list.length > 0
  histList.replaceChildren()
  for (const e of list) {
    const row = document.createElement('div')
    row.className = 'hist-row'
    const select = document.createElement('input')
    select.type = 'checkbox'
    select.className = 'hist-select'
    select.setAttribute('aria-label', `Select capture from ${new Date(e.ts).toLocaleString()}`)
    select.addEventListener('change', () => {
      if (select.checked) selectedHistory.add(e)
      else selectedHistory.delete(e)
      updateHistorySelection()
    })

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'hist-open'
    const img = document.createElement('img')
    img.src = e.result.imageDataUrl
    img.alt = ''
    const meta = document.createElement('span')
    meta.className = 'hist-meta'
    const when = document.createElement('span')
    when.className = 'hist-when'
    when.textContent = `${new Date(e.ts).toLocaleString()} · ${e.result.mode}`
    const snip = document.createElement('span')
    snip.className = 'hist-snip'
    snip.textContent = histSnippet(e.result)
    meta.append(when, snip)
    open.append(img, meta)
    open.addEventListener('click', () => renderResult(e.result, false))

    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'hist-del'
    del.title = 'Delete'
    del.setAttribute('aria-label', 'Delete this capture')
    del.textContent = '×'
    del.addEventListener('click', async () => {
      const cur = await loadHistory()
      await chrome.storage.local.set({ [HIST_KEY]: cur.filter((x) => x.ts !== e.ts) })
      void openHistory()
    })

    row.append(select, open, del)
    histList.appendChild(row)
  }
  setState('history')
}

histBtn.addEventListener('click', () => void openHistory())
$<HTMLButtonElement>('hist-back').addEventListener('click', () =>
  setState(lastResult ? 'result' : 'idle'),
)
histEnabledBox.addEventListener('change', () => {
  historyEnabled = histEnabledBox.checked
  savePrefs()
})
histClear.addEventListener('click', async () => {
  await chrome.storage.local.remove(HIST_KEY)
  void openHistory()
})

// ── OCR an image directly (open / paste / drop) — no page capture ────────────
// Reuses the REPROCESS path: the SW forwards the data URL to the engine exactly
// as it does when reinterpreting a captured crop.

function ocrDataUrl(imageDataUrl: string): void {
  chrome.runtime.sendMessage({ type: 'REPROCESS', imageDataUrl, mode: captureMode } satisfies Reprocess)
  busyLabel.textContent = 'Reading image…'
  progressFill.style.width = '30%'
  spinnerEl.hidden = false
  selectingNote.hidden = true
  busySkeleton.hidden = false
  setState('busy')
}

function ocrImageFile(file: File): void {
  if (currentState === 'busy' || pdfController) return
  const fr = new FileReader()
  fr.onload = () => ocrDataUrl(fr.result as string)
  fr.readAsDataURL(file)
}

const imageInput = $<HTMLInputElement>('image-input')
$<HTMLButtonElement>('open-image').addEventListener('click', () => imageInput.click())
imageInput.addEventListener('change', () => {
  const f = imageInput.files?.[0]
  if (f) ocrImageFile(f)
  imageInput.value = '' // re-selecting the same file must fire change again
})

document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))
  const f = item?.getAsFile()
  if (f) {
    e.preventDefault()
    ocrImageFile(f)
  }
})

document.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
})
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0]
  if (f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) {
    e.preventDefault()
    openPdf(f)
  } else if (f?.type.startsWith('image/')) {
    e.preventDefault()
    ocrImageFile(f)
  }
})

// PDF bytes and extracted text are kept in this panel only, never in history.
let pdfFile: File | null = null
let pdfText = ''
const pdfInput = $<HTMLInputElement>('pdf-input')
const pdfRead = $<HTMLButtonElement>('pdf-read')
const pdfCancel = $<HTMLButtonElement>('pdf-cancel')
const pdfCopy = $<HTMLButtonElement>('pdf-copy')
const pdfSave = $<HTMLButtonElement>('pdf-save')
const pdfProgress = $('pdf-progress')
function openPdf(file: File): void {
  if (currentState === 'busy' || pdfController) return
  pdfFile = file
  pdfText = ''
  $('pdf-name').textContent = file.name
  $('pdf-text').textContent = ''
  pdfProgress.textContent = ''
  $<HTMLInputElement>('pdf-first').value = '1'
  $<HTMLInputElement>('pdf-last').value = ''
  pdfRead.disabled = file.size > 50_000_000
  if (pdfRead.disabled) pdfProgress.textContent = 'This PDF exceeds the 50 MB limit.'
  pdfCopy.disabled = pdfSave.disabled = true
  setState('pdf')
}
$('open-pdf').addEventListener('click', () => pdfInput.click())
pdfInput.addEventListener('change', () => {
  const f = pdfInput.files?.[0]
  if (f) openPdf(f)
  pdfInput.value = ''
})
pdfRead.addEventListener('click', async () => {
  if (!pdfFile || pdfController) return
  const controller = new AbortController()
  pdfController = controller
  pdfRead.disabled = true
  pdfCancel.disabled = false
  pdfCopy.disabled = pdfSave.disabled = true
  pdfText = ''
  $('pdf-text').textContent = ''
  pdfProgress.textContent = 'Opening PDF on this device…'
  const firstPage = Number($<HTMLInputElement>('pdf-first').value)
  const lastValue = $<HTMLInputElement>('pdf-last').value
  const forceOcr = $<HTMLInputElement>('pdf-force-ocr').checked
  const pdfLang = lang
  setState('pdf')
  try {
    const { readPdf } = await import('./pdf')
    const result = await readPdf(new Uint8Array(await pdfFile.arrayBuffer()), {
      signal: controller.signal, firstPage, lastPage: lastValue ? Number(lastValue) : undefined, forceOcr,
      onProgress: (page, total) => { pdfProgress.textContent = `Reading page ${page} of ${total}…` },
      ocr: async (imageDataUrl) => {
        const ready = await chrome.runtime.sendMessage({ type: 'ENSURE_OFFSCREEN' })
        if (!ready?.ok) throw new Error('Could not start local OCR.')
        const out = await chrome.runtime.sendMessage({ type: 'PDF_OCR_IMAGE', imageDataUrl, lang: pdfLang })
        if (out?.error || typeof out?.text !== 'string') throw new Error(out?.error || 'No OCR result for this page.')
        return out.text
      },
    })
    controller.signal.throwIfAborted()
    pdfText = result.text
    $('pdf-text').textContent = pdfText
    pdfProgress.textContent = `Read ${result.pages} pages (${result.ocrPages} with OCR). Check the result against the PDF.`
    pdfCopy.disabled = pdfSave.disabled = !pdfText.trim()
    void copyAutomatically(pdfText)
  } catch (err) {
    pdfProgress.textContent = controller.signal.aborted ? 'Cancelled. No partial result was saved.' : `Could not read PDF: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    pdfController = null
    pdfRead.disabled = false
    pdfCancel.disabled = true
    setState('pdf')
  }
})
pdfCancel.addEventListener('click', () => {
  pdfController?.abort()
  pdfCancel.disabled = true
  pdfProgress.textContent = 'Cancelling…'
})
pdfCopy.addEventListener('click', () => void copyText(pdfText))
pdfSave.addEventListener('click', () => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([pdfText], { type: 'text/plain;charset=utf-8' }))
  a.download = 'ocr-buddy-pdf.txt'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
})

// Version next to the brand, read from the manifest so it can't drift.
$('version').textContent = `v${chrome.runtime.getManifest().version}`

// Home: back to the main (idle) menu from any state — e.g. to change mode or
// language after a result. The result stays reachable via History.
$<HTMLButtonElement>('home-btn').addEventListener('click', () => setState('idle'))

// Show the platform-correct modifier in the shortcut hint (⌘ on macOS). The
// binding itself (Ctrl+Shift+Y / Command+Shift+Y) lives in the manifest command.
const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent)
if (isMac) {
  const modEl = document.getElementById('kbd-mod')
  if (modEl) modEl.textContent = '⌘'
}

void restorePrefs()
setState('idle')

// ----- Review prompt (fixed idle link + gentle nudge) -----
const reviewNudge = $('review-nudge')
const reviewNudgeTitle = $('review-nudge-title')
const reviewStarsNudge = $('review-stars-nudge')
const reviewStarsIdle = $('review-stars-idle')

// Fixed idle link: always present and usable on every launch. Opens the store and
// never freezes into a "thanks" state, so it stays a working entry point. It does
// NOT mark the user rated — only the nudge does that.
reviewStarsIdle.replaceChildren(renderStars(openReviewPage))

// Nudge stars: open the store AND stop the periodic nudge for good (the nudge is
// the part that nags, so acting on it self-suppresses).
function onNudgeRate() {
  openReviewPage()
  void markRated()
  reviewNudge.hidden = true
}

$<HTMLButtonElement>('review-dismiss').addEventListener('click', () => {
  reviewNudge.hidden = true
})

/** Count a fresh successful capture; show the nudge if it crossed the threshold. */
async function maybeShowNudge() {
  const count = await recordSuccessAndMaybeNudge()
  if (count === null) return
  reviewNudgeTitle.textContent = `Nice, that's ${count} captures with OCR Buddy.`
  // Mount fresh stars so their entrance animation replays on each appearance.
  reviewStarsNudge.replaceChildren(renderStars(onNudgeRate))
  reviewNudge.hidden = false
  reviewNudge.classList.remove('in')
  void reviewNudge.offsetWidth // force reflow so the container animation replays
  reviewNudge.classList.add('in')
}
