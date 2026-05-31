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

chrome.runtime.onMessage.addListener((msg: Message, _sender) => {
  if (msg.type === 'START_SELECTION') {
    void startActiveTabSelection()
  } else if (msg.type === 'CAPTURE_REQUEST') {
    void handleCapture(msg)
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

/** Show the selection overlay on a tab; guide the user if it isn't reachable. */
async function startSelection(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_OVERLAY' } satisfies ShowOverlay)
    chrome.runtime.sendMessage({ type: 'OCR_STATUS', stage: 'selecting' })
  } catch {
    // No overlay content script here (page predates the extension load, or it's a
    // restricted page like chrome://). Tell the user how to recover.
    chrome.runtime.sendMessage({
      type: 'OCR_STATUS',
      stage: 'error',
      message:
        'Can’t start here. Reload the page (Ctrl/Cmd+R), or press Ctrl+Shift+Y on the tab you want to capture. Browser pages (chrome://) can’t be captured.',
    })
  }
}

async function handleCapture(req: CaptureRequest): Promise<void> {
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
    }
    await chrome.runtime.sendMessage(runMsg)
  } catch (err) {
    chrome.runtime.sendMessage({
      type: 'OCR_STATUS',
      stage: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
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
