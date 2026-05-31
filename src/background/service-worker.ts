// Service worker = COORDINATOR ONLY (no DOM, no model, no inference).
// Responsibilities:
//   1. On action click: open side panel + inject the selection overlay (activeTab).
//   2. Receive the selected rect → captureVisibleTab → crop on OffscreenCanvas.
//   3. Ensure the offscreen document exists → forward the crop for OCR.
//   4. Relay status/result messages to the side panel.

import type { CaptureRequest, Message, RunOcr, ShowOverlay } from '../shared/messages'

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html'
const V1_LANGS = ['en', 'it', 'fr', 'de', 'es'] // Latin + IT/EU (research §v1)

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return
  await chrome.sidePanel.open({ tabId: tab.id })
  // Wake the passive overlay content script on this tab. It's only present on
  // pages loaded after the extension was installed/reloaded, so a tab that was
  // already open won't have the listener yet → tell the user to reload.
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_OVERLAY' } satisfies ShowOverlay)
  } catch {
    chrome.runtime.sendMessage({
      type: 'OCR_STATUS',
      stage: 'error',
      message: 'This page was open before OCR Buddy loaded. Reload it (Ctrl/Cmd+R), then click again.',
    })
  }
})

chrome.runtime.onMessage.addListener((msg: Message, _sender) => {
  if (msg.type === 'CAPTURE_REQUEST') {
    void handleCapture(msg)
  }
  // OCR_STATUS / OCR_RESULT come from the offscreen doc and are addressed to the
  // side panel; they're broadcast via runtime messaging, so no relay needed here.
  return false
})

async function handleCapture(req: CaptureRequest): Promise<void> {
  try {
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
