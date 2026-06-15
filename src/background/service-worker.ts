// Service worker = COORDINATOR ONLY (no DOM, no model, no inference).
// Responsibilities:
//   1. Toolbar icon → open the side panel (no auto-selection).
//   2. "Select region" button / Ctrl+Shift+O → show the overlay on the active tab.
//   3. Receive the selected rect → captureVisibleTab → crop on OffscreenCanvas.
//   4. Ensure the offscreen document exists → forward the crop for OCR.

import { PREFS_KEY } from '../shared/messages'
import type { CaptureMode, CaptureRequest, CaptureViewport, Message, PanelPrefs, RunOcr, ShowOverlay } from '../shared/messages'

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html'

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
  await startSelection(tab.id, await lastMode())
})

// Right-click an image → OCR it directly (no region selection). The click also
// grants activeTab, which doubles as temporary host access for same-origin
// image fetches.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'ocr-image',
    title: 'OCR this image with OCR Buddy',
    contexts: ['image'],
  })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ocr-image' || !info.srcUrl) return
  if (tab?.id !== undefined) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id })
    } catch {
      /* panel already open or gesture expired — results still broadcast */
    }
  }
  try {
    const dataUrl = info.srcUrl.startsWith('data:')
      ? info.srcUrl
      : await blobToDataUrl(await (await fetch(info.srcUrl)).blob())
    // Give the freshly-opened panel a beat to attach its message listener.
    await new Promise((r) => setTimeout(r, 300))
    await reprocess(dataUrl, await lastMode())
  } catch {
    chrome.runtime.sendMessage({
      type: 'OCR_STATUS',
      stage: 'error',
      message:
        "Couldn't fetch this image (the site blocks cross-origin access). " +
        'Use "Select region" over it instead — that path always works.',
    })
  }
})

// The action to retry after the user grants per-site permission: either a
// selection that couldn't start (overlay/host access) or a capture that failed.
// The capture mode itself is NOT held here: it rides inside SHOW_OVERLAY /
// CAPTURE_REQUEST, so it survives the SW being recycled mid-selection.
type Pending =
  | { kind: 'select'; tabId: number; mode: CaptureMode }
  | { kind: 'capture'; req: CaptureRequest }
  | { kind: 'viewport'; msg: CaptureViewport }
let pending: Pending | null = null

chrome.runtime.onMessage.addListener((msg: Message, _sender) => {
  if (msg.type === 'START_SELECTION') {
    void startActiveTabSelection(msg.mode ?? 'quick')
  } else if (msg.type === 'CAPTURE_REQUEST') {
    void handleCapture(msg)
  } else if (msg.type === 'CAPTURE_VIEWPORT') {
    void handleViewport(msg)
  } else if (msg.type === 'REPROCESS') {
    // Reinterpret an already-captured crop in a different mode — no re-selection.
    void reprocess(msg.imageDataUrl, msg.mode)
  } else if (msg.type === 'PERMISSION_GRANTED') {
    // The MV3 service worker can be recycled while the permission prompt is open,
    // dropping in-memory `pending` — which left "Allow" doing nothing. Fall back to
    // a fresh selection on the active tab (now that host access is granted) so the
    // grant always leads somewhere.
    if (pending?.kind === 'capture') void handleCapture(pending.req)
    else if (pending?.kind === 'select') void startSelection(pending.tabId, pending.mode)
    else if (pending?.kind === 'viewport') void handleViewport(pending.msg)
    else void startActiveTabSelectionWithLastMode()
  }
  // OCR_STATUS / OCR_RESULT from the offscreen doc are addressed to the side panel
  // via broadcast — no relay needed here.
  return false
})

/** The panel's persisted prefs: capture mode for entry points that don't carry
 * one (keyboard shortcut, post-grant fallback) and the OCR language pack. */
async function panelPrefs(): Promise<PanelPrefs> {
  try {
    const got = await chrome.storage.local.get(PREFS_KEY)
    return (got[PREFS_KEY] as PanelPrefs | undefined) ?? {}
  } catch {
    return {}
  }
}

const lastMode = async (): Promise<CaptureMode> => (await panelPrefs()).captureMode ?? 'quick'

async function startActiveTabSelectionWithLastMode(): Promise<void> {
  await startActiveTabSelection(await lastMode())
}

/** Resolve the active tab, then start selection on it. */
async function startActiveTabSelection(mode: CaptureMode): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id === undefined) return
  await startSelection(tab.id, mode)
}

/** Show the overlay on a tab, injecting it first if the content script is absent.
 * If we lack host access, ask the user to grant capture for this site. */
async function startSelection(tabId: number, mode: CaptureMode): Promise<void> {
  pending = { kind: 'select', tabId, mode }
  if (await showOverlay(tabId, mode)) return
  try {
    await injectOverlay(tabId) // needs host access (activeTab / granted host)
    if (await showOverlay(tabId, mode)) return
  } catch {
    // injection blocked — fall through to the permission prompt
  }
  chrome.runtime.sendMessage({ type: 'NEED_PERMISSION', origin: await originOf(tabId) })
}

/** Tell the overlay (if present) to show; true on success. */
async function showOverlay(tabId: number, mode: CaptureMode): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_OVERLAY', mode } satisfies ShowOverlay)
    chrome.runtime.sendMessage({ type: 'OCR_STATUS', stage: 'selecting' })
    return true
  } catch {
    return false
  }
}

/** Inject the overlay on demand. There is no declared content script (that would
 * cost the all-sites install warning); the overlay is built to this fixed path
 * (vite.config.ts) and injected only on user action, under activeTab or a
 * per-site grant. */
async function injectOverlay(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/overlay.js'] })
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

/** Re-run OCR on a crop we already captured, in a new mode (no screenshot). */
async function reprocess(imageDataUrl: string, mode: CaptureMode): Promise<void> {
  await ensureOffscreen()
  const { lang } = await panelPrefs()
  await chrome.runtime.sendMessage({ type: 'RUN_OCR', imageDataUrl, lang, mode } satisfies RunOcr)
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
      lang: (await panelPrefs()).lang,
      mode: req.mode,
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

/** Capture the whole visible viewport (no region selection) and OCR it. */
async function handleViewport(msg: CaptureViewport): Promise<void> {
  pending = { kind: 'viewport', msg }
  try {
    chrome.runtime.sendMessage({ type: 'OCR_STATUS', stage: 'capturing' })
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' })
    await ensureOffscreen()
    const runMsg: RunOcr = {
      type: 'RUN_OCR',
      imageDataUrl: dataUrl,
      lang: (await panelPrefs()).lang,
      mode: msg.mode,
    }
    await chrome.runtime.sendMessage(runMsg)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/activeTab|all_urls|permission/i.test(message)) {
      chrome.runtime.sendMessage({ type: 'NEED_PERMISSION', origin: msg.origin })
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
