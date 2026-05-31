// Service worker = COORDINATOR ONLY (no DOM, no model, no inference).
// Responsibilities:
//   1. Toolbar icon → open the side panel (no auto-selection).
//   2. "Select region" button / Ctrl+Shift+O → show the overlay on the active tab.
//   3. Receive the selected rect → captureVisibleTab → crop on OffscreenCanvas.
//   4. Ensure the offscreen document exists → forward the crop for OCR.

import type { CaptureRequest, Message, RunOcr, ShowOverlay } from '../shared/messages'

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html'
const V1_LANGS = ['en', 'it', 'fr', 'de', 'es'] // Latin + IT/EU (research §v1)

// Toolbar icon: open the panel only. The click grants activeTab for this tab, so
// the panel's "Select region" button can capture it without page dimming on open.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void chrome.sidePanel.open({ tabId: tab.id })
})

// Keyboard shortcut: open the panel AND start selection in one step (the command
// also grants activeTab, so it works on any tab, not just one already opened).
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'start-capture' || tab?.id === undefined) return
  await chrome.sidePanel.open({ tabId: tab.id })
  await startSelection(tab.id)
})

// The action to retry after the user grants per-site permission: either a
// selection that couldn't start (overlay/host access) or a capture that failed.
type Pending = { kind: 'select'; tabId: number } | { kind: 'capture'; req: CaptureRequest }
let pending: Pending | null = null

// Capture mode chosen at selection time (quick OCR vs document layout analysis).
let captureMode: 'quick' | 'document' = 'quick'

chrome.runtime.onMessage.addListener((msg: Message, _sender) => {
  if (msg.type === 'START_SELECTION') {
    captureMode = msg.document ? 'document' : 'quick'
    void startActiveTabSelection()
  } else if (msg.type === 'CAPTURE_REQUEST') {
    void handleCapture(msg)
  } else if (msg.type === 'PERMISSION_GRANTED') {
    if (pending?.kind === 'capture') void handleCapture(pending.req)
    else if (pending?.kind === 'select') void startSelection(pending.tabId)
  }
  // OCR_STATUS / OCR_RESULT from the offscreen doc are addressed to the side panel
  // via broadcast — no relay needed here.
  return false
})

/** Resolve the active tab, then start selection on it. */
async function startActiveTabSelection(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id === undefined) return
  await startSelection(tab.id)
}

/** Show the overlay on a tab, injecting it first if the content script is absent.
 * If we lack host access, ask the user to grant capture for this site. */
async function startSelection(tabId: number): Promise<void> {
  pending = { kind: 'select', tabId }
  if (await showOverlay(tabId)) return
  try {
    await injectOverlay(tabId) // needs host access (activeTab / granted host)
    if (await showOverlay(tabId)) return
  } catch {
    // injection blocked — fall through to the permission prompt
  }
  chrome.runtime.sendMessage({ type: 'NEED_PERMISSION', origin: await originOf(tabId) })
}

/** Tell the overlay (if present) to show; true on success. */
async function showOverlay(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_OVERLAY' } satisfies ShowOverlay)
    chrome.runtime.sendMessage({ type: 'OCR_STATUS', stage: 'selecting' })
    return true
  } catch {
    return false
  }
}

/** Inject the overlay content script on demand (path read from the built manifest). */
async function injectOverlay(tabId: number): Promise<void> {
  const file = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0]
  if (!file) throw new Error('overlay script not found in manifest')
  await chrome.scripting.executeScript({ target: { tabId }, files: [file] })
}

/** Best-effort tab origin (empty if we can't read it without permission). */
async function originOf(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId)
    return tab.url ? new URL(tab.url).origin : ''
  } catch {
    return ''
  }
}

async function handleCapture(req: CaptureRequest): Promise<void> {
  pending = { kind: 'capture', req }
  try {
    chrome.runtime.sendMessage({ type: 'OCR_STATUS', stage: 'capturing' })
    // captureVisibleTab returns CLEAN composited pixels — taint-free even over
    // cross-origin <video> (the YouTube-code case). See research §2.4.
    const fullDataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' })
    const cropDataUrl = await cropRegion(fullDataUrl, req)

    await ensureOffscreen()
    const runMsg: RunOcr = {
      type: 'RUN_OCR',
      imageDataUrl: cropDataUrl,
      langs: V1_LANGS,
      mode: captureMode,
    }
    await chrome.runtime.sendMessage(runMsg)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Missing host/activeTab permission for this tab → ask the user to grant it
    // for this site (runtime, per-origin), then retry.
    if (/activeTab|all_urls|permission/i.test(message)) {
      chrome.runtime.sendMessage({ type: 'NEED_PERMISSION', origin: req.origin })
    } else {
      chrome.runtime.sendMessage({ type: 'OCR_STATUS', stage: 'error', message })
    }
  }
}

/** Crop the selected rect out of the full viewport PNG, scaling by DPR. */
async function cropRegion(
  fullDataUrl: string,
  { rect, devicePixelRatio: dpr }: CaptureRequest,
): Promise<string> {
  const resp = await fetch(fullDataUrl)
  const bitmap = await createImageBitmap(await resp.blob())

  const sx = rect.x * dpr
  const sy = rect.y * dpr
  const sw = rect.width * dpr
  const sh = rect.height * dpr

  const canvas = new OffscreenCanvas(Math.max(1, sw), Math.max(1, sh))
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  bitmap.close()

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await blobToDataUrl(blob)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}

/** Only one offscreen document may exist per extension — check before creating. */
async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH)
  const existing = (await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  })) as chrome.runtime.ExtensionContext[]
  if (existing.length > 0) return

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'Run local OCR (ONNX Runtime) in a dedicated worker off the service worker.',
  })
}
