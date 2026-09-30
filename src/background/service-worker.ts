// Service worker = COORDINATOR ONLY (no DOM, no model, no inference).
// Responsibilities:
//   1. Toolbar icon → open the side panel, optionally select per local prefs.
//   2. Native commands → select a region, capture a viewport, or capture a page.
//   3. Receive the selected rect → captureVisibleTab → crop on OffscreenCanvas.
//   4. Ensure the offscreen document exists → forward the crop for OCR.

import { PREFS_KEY } from '../shared/messages'
import type { CaptureFullPage, CaptureMode, CaptureRequest, CaptureViewport, ConvertPageMd, Message, PanelPrefs, Restricted, RunOcr, RunOcrTiles, ShowOverlay } from '../shared/messages'
import { restrictedReason } from '../shared/restricted'
import { ensureOcrHost, openResultPanel } from '../shared/browser-compat'
import { captureFullPage, captureTab } from './fullpage'

// Open before any asynchronous work so Chrome retains the user gesture.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return
  const tabId = tab.id
  entrypoint(async () => {
    if (!await openPanel(tabId)) return
    const prefs = await panelPrefs()
    if (prefs.iconAction === 'select') entrypoint(() => startSelection(tabId, prefs.captureMode ?? 'quick'), true)
  })
})

chrome.commands.onCommand.addListener((command, tab) => {
  if (!['start-capture', 'capture-viewport', 'capture-fullpage'].includes(command) || tab?.id === undefined) return
  const tabId = tab.id
  entrypoint(async () => {
    if (!await openPanel(tabId)) return
    if (command === 'start-capture') await startSelection(tabId, await lastMode())
    else if (command === 'capture-viewport') {
      await handleViewport({ type: 'CAPTURE_VIEWPORT', tabId, mode: await lastMode(), origin: await originOf(tabId) })
    } else {
      await handleFullPage({ type: 'CAPTURE_FULLPAGE', tabId, origin: await originOf(tabId) })
    }
  }, true)
})

let captureBusy = false

/** Covers selection setup / capture through OCR handoff, not the asynchronous
 * engine or panel-owned PDF queue. Never holds a lock while a user selects. */
function entrypoint(task: () => Promise<void>, exclusive = false): void {
  if (exclusive && captureBusy) return
  if (exclusive) captureBusy = true
  void task().catch((err) => postCaptureError(err, '')).finally(() => {
    if (exclusive) captureBusy = false
  })
}

/** A notification may have no receiver (panel closed). Do not leak rejections. */
function post(msg: Message): void {
  void chrome.runtime.sendMessage(msg).catch(() => {})
}

async function openPanel(tabId: number): Promise<boolean> {
  await openResultPanel(tabId)
  // A context existing is not evidence that its JS listener is ready. The panel
  // acknowledges this probe synchronously; retries are bounded and carry no data.
  for (let attempt = 0; attempt < 40; attempt++) {
    const reply = await chrome.runtime.sendMessage({ type: 'PANEL_READY' }).catch(() => undefined)
    if (reply?.ok === true) return reply.busy !== true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('The OCR panel is not ready. Reopen it and try again.')
}

// Right-click an image → OCR it directly (no region selection). The click also
// grants activeTab, which doubles as temporary host access for same-origin
// image fetches.
chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({
    id: 'ocr-image',
    title: 'OCR this image with OCR Buddy',
    contexts: ['image'],
  })
  if (details.reason === 'update' && details.previousVersion !== chrome.runtime.getManifest().version) {
    void chrome.tabs.create({ url: chrome.runtime.getURL('updates.html') }).catch(() => {})
  }
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'ocr-image' || !info.srcUrl || tab?.id === undefined) return
  const srcUrl = info.srcUrl
  const tabId = tab.id
  entrypoint(async () => {
    if (!await openPanel(tabId)) return
    try {
      const dataUrl = srcUrl.startsWith('data:')
        ? srcUrl
        : await blobToDataUrl(await (await fetch(srcUrl)).blob())
      await reprocess(dataUrl, await lastMode())
    } catch {
      post({
        type: 'OCR_STATUS',
        stage: 'error',
        message:
          "Couldn't fetch this image (the site blocks cross-origin access). " +
          'Use "Select region" over it instead — that path always works.',
      })
    }
  }, true)
})

// The action to retry after the user grants per-site permission: either a
// selection that couldn't start (overlay/host access) or a capture that failed.
// The capture mode itself is NOT held here: it rides inside SHOW_OVERLAY /
// CAPTURE_REQUEST, so it survives the SW being recycled mid-selection.
type Pending =
  | { kind: 'select'; tabId: number; mode: CaptureMode }
  | { kind: 'capture'; req: CaptureRequest; tabId?: number; documentId?: string }
  | { kind: 'viewport'; msg: CaptureViewport }
  | { kind: 'fullpage'; msg: CaptureFullPage }
  | { kind: 'md'; msg: ConvertPageMd }
let pending: Pending | null = null
let selectionTabId: number | undefined

function selectionUnavailable(tabId: number): void {
  if (selectionTabId !== tabId) return
  selectionTabId = undefined
  post({ type: 'SELECTION_CANCELLED' })
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' || info.url !== undefined) selectionUnavailable(tabId)
})
chrome.tabs.onRemoved.addListener(selectionUnavailable)

async function cancelSelection(): Promise<void> {
  const selected = selectionTabId
  selectionTabId = undefined
  if (pending?.kind === 'select') pending = null
  // Tracking is in-memory; after an MV3 restart the active tab is the fallback.
  const tabId = selected ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id
  if (tabId !== undefined) await chrome.tabs.sendMessage(tabId, { type: 'HIDE_OVERLAY' })
}

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  const ownPage = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''))
  // Extension pages can also live in tabs. Only a content script's tab identifies
  // the capture source; a panel tab must preserve the explicitly requested target.
  const contentTab = sender.id === chrome.runtime.id && sender.url && !sender.url.startsWith('chrome-extension://')
    ? sender.tab : undefined
  if (msg.type === 'COPY_TEXT' || msg.type === 'ENSURE_OFFSCREEN') {
    // Clipboard access is limited to the exact panel page (queries/fragments are
    // harmless), whether it is hosted in the side panel or an extension tab.
    const ownPanel = ownPage && sender.url?.split(/[?#]/, 1)[0] === chrome.runtime.getURL('src/sidepanel/index.html')
    if (!ownPage || (msg.type === 'COPY_TEXT' && !ownPanel)) {
      sendResponse({ ok: false, error: 'Only trusted extension pages may use this request.' })
      return false
    }
    void (async () => {
      if (msg.type === 'COPY_TEXT') {
        if (typeof msg.text !== 'string' || msg.text.length > 2_000_000) throw new Error('Invalid clipboard text (maximum 2,000,000 characters).')
        if (!await chrome.permissions.contains({ permissions: ['clipboardWrite'] })) throw new Error('Clipboard permission has not been granted.')
        await ensureOcrHost()
        const reply = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_COPY_TEXT', text: msg.text })
        if (reply?.ok !== true) throw new Error(reply?.error ?? 'Offscreen clipboard did not respond.')
      } else await ensureOcrHost()
      return { ok: true }
    })().then(sendResponse, (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    return true
  }
  if (msg.type === 'START_SELECTION') {
    entrypoint(() => startActiveTabSelection(msg.mode ?? 'quick'), true)
  } else if (msg.type === 'CANCEL_SELECTION' && ownPage) {
    // The panel restores its state immediately; a closed/navigated tab is normal.
    void cancelSelection().catch(() => {})
  } else if (msg.type === 'SELECTION_CANCELLED') {
    if (contentTab?.id === selectionTabId || ownPage) selectionTabId = undefined
  } else if (msg.type === 'CAPTURE_REQUEST') {
    if (contentTab?.id === selectionTabId || ownPage) selectionTabId = undefined
    entrypoint(() => handleCapture(msg, contentTab?.id, contentTab ? sender.documentId : undefined), true)
  } else if (msg.type === 'CAPTURE_VIEWPORT') {
    entrypoint(() => handleViewport({ ...msg, tabId: contentTab?.id ?? msg.tabId }), true)
  } else if (msg.type === 'CAPTURE_FULLPAGE') {
    entrypoint(() => handleFullPage(msg), true)
  } else if (msg.type === 'CONVERT_PAGE_MD') {
    entrypoint(() => handleConvertPageMd(msg), true)
  } else if (msg.type === 'REPROCESS') {
    // Reinterpret an already-captured crop in a different mode — no re-selection.
    entrypoint(() => reprocess(msg.imageDataUrl, msg.mode), true)
  } else if (msg.type === 'PERMISSION_GRANTED') {
    // The MV3 service worker can be recycled while the permission prompt is open,
    // dropping in-memory `pending` — which left "Allow" doing nothing. Fall back to
    // a fresh selection on the active tab (now that host access is granted) so the
    // grant always leads somewhere.
    entrypoint(async () => {
      const retry = pending
      pending = null
      if (retry?.kind === 'capture') await handleCapture(retry.req, retry.tabId, retry.documentId)
      else if (retry?.kind === 'select') await startSelection(retry.tabId, retry.mode)
      else if (retry?.kind === 'viewport') await handleViewport(retry.msg)
      else if (retry?.kind === 'fullpage') await handleFullPage(retry.msg)
      else if (retry?.kind === 'md') await handleConvertPageMd(retry.msg)
      else await startActiveTabSelectionWithLastMode()
    }, true)
  }
  // OCR_STATUS / OCR_RESULT from the OCR host are addressed to the side panel
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
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (!tab || !tab.active) throw new Error('The selection tab is no longer active. Return to it and try again.')
  if (blockedIfRestricted(tab?.url)) return
  pending = { kind: 'select', tabId, mode }
  if (await showOverlay(tabId, mode)) { pending = null; return }
  try {
    await injectOverlay(tabId) // needs host access (activeTab / granted host)
    if (await showOverlay(tabId, mode)) { pending = null; return }
  } catch {
    // injection blocked — fall through to the permission prompt
  }
  post({ type: 'NEED_PERMISSION', origin: await originOf(tabId) })
}

/** Tell the overlay (if present) to show; true on success. */
async function showOverlay(tabId: number, mode: CaptureMode): Promise<boolean> {
  selectionTabId = tabId
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_OVERLAY', mode } satisfies ShowOverlay)
    if (selectionTabId === tabId) post({ type: 'OCR_STATUS', stage: 'selecting' })
    return true
  } catch {
    // A cancellation/navigation during delivery must not trigger reinjection.
    if (selectionTabId !== tabId) return true
    selectionTabId = undefined
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

/** If a tab's page is one Chrome forbids all extensions from touching (the Web
 *  Store, chrome:// …), tell the panel to abstain honestly and return true. No
 *  permission prompt can help, so callers must NOT fall through to NEED_PERMISSION. */
function blockedIfRestricted(url: string | undefined): boolean {
  const reason = restrictedReason(url)
  if (!reason) return false
  pending = null
  post({ type: 'RESTRICTED', reason } satisfies Restricted)
  return true
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
  await ensureOcrHost()
  const { lang } = await panelPrefs()
  await chrome.runtime.sendMessage({ type: 'RUN_OCR', imageDataUrl, lang, mode } satisfies RunOcr)
}

/** Post NEED_PERMISSION for a missing host/activeTab grant, else surface the error. */
function postCaptureError(err: unknown, origin: string): void {
  const message = err instanceof Error ? err.message : String(err)
  if (/activeTab|all_urls|permission|cannot be scripted|Cannot access/i.test(message)) {
    post({ type: 'NEED_PERMISSION', origin })
  } else {
    pending = null
    post({ type: 'OCR_STATUS', stage: 'error', message })
  }
}

async function captureTarget(tabId?: number): Promise<chrome.tabs.Tab> {
  const tab = tabId === undefined
    ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
    : await chrome.tabs.get(tabId)
  if (tab?.id === undefined) throw new Error('The tab to capture is no longer available.')
  return tab
}

function checkOrigin(tab: chrome.tabs.Tab, origin: string): void {
  if (origin && tab.url && new URL(tab.url).origin !== origin) {
    throw new Error('The capture page changed. Return to the intended page and try again.')
  }
}

async function handleCapture(req: CaptureRequest, tabId?: number, documentId?: string): Promise<void> {
  pending = { kind: 'capture', req, tabId, documentId }
  try {
    const tab = await captureTarget(tabId)
    pending = { kind: 'capture', req, tabId: tab.id, documentId }
    if (blockedIfRestricted(tab.url)) return
    checkOrigin(tab, req.origin)
    post({ type: 'OCR_STATUS', stage: 'capturing' })
    // captureVisibleTab returns CLEAN composited pixels — taint-free even over
    // cross-origin <video> (the YouTube-code case). See research §2.4.
    const fullDataUrl = await captureTab(tab.id!, tab.windowId, documentId)
    const cropDataUrl = await cropRegion(fullDataUrl, req)

    await ensureOcrHost()
    const runMsg: RunOcr = {
      type: 'RUN_OCR',
      imageDataUrl: cropDataUrl,
      lang: (await panelPrefs()).lang,
      mode: req.mode,
    }
    await chrome.runtime.sendMessage(runMsg)
    pending = null
  } catch (err) {
    postCaptureError(err, req.origin)
  }
}

/** Capture the whole visible viewport (no region selection) and OCR it. */
async function handleViewport(msg: CaptureViewport): Promise<void> {
  pending = { kind: 'viewport', msg }
  try {
    const active = await captureTarget(msg.tabId)
    pending = { kind: 'viewport', msg: { ...msg, tabId: active.id } }
    if (blockedIfRestricted(active.url)) return
    checkOrigin(active, msg.origin)
    post({ type: 'OCR_STATUS', stage: 'capturing' })
    const dataUrl = await captureTab(active.id!, active.windowId)
    await ensureOcrHost()
    const runMsg: RunOcr = {
      type: 'RUN_OCR',
      imageDataUrl: dataUrl,
      lang: (await panelPrefs()).lang,
      mode: msg.mode,
    }
    await chrome.runtime.sendMessage(runMsg)
    pending = null
  } catch (err) {
    postCaptureError(err, msg.origin)
  }
}

/** Capture the full scrollable page, then hand the tiles to the offscreen doc. */
async function handleFullPage(msg: CaptureFullPage): Promise<void> {
  pending = { kind: 'fullpage', msg }
  try {
    const tab = await chrome.tabs.get(msg.tabId)
    if (blockedIfRestricted(tab.url)) return
    checkOrigin(tab, msg.origin)
    if (tab.id === undefined) {
      pending = null
      post({ type: 'OCR_STATUS', stage: 'error', message: 'The tab to capture is no longer available.' })
      return
    }
    post({ type: 'OCR_STATUS', stage: 'capturing' })
    const { tiles, truncated } = await captureFullPage(tab.id, tab.windowId, (t) =>
      post({
        type: 'OCR_STATUS',
        stage: 'capturing',
        message: `Capturing page… tile ${t}`,
      }),
    )
    if (!tiles.length) {
      pending = null
      post({ type: 'OCR_STATUS', stage: 'error', message: 'Nothing to capture on this page.' })
      return
    }
    await ensureOcrHost()
    const runMsg: RunOcrTiles = {
      type: 'RUN_OCR_TILES',
      imageDataUrls: tiles,
      lang: (await panelPrefs()).lang,
      truncated,
    }
    await chrome.runtime.sendMessage(runMsg)
    pending = null
  } catch (err) {
    postCaptureError(err, msg.origin)
  }
}

/** Read the page's full HTML (no OCR — structure comes from the DOM) and hand it to
 *  the panel, which converts it to Markdown. The injected function is self-contained
 *  (classic script, no imports), same constraint as fullpage.ts's injects. */
async function handleConvertPageMd(msg: ConvertPageMd): Promise<void> {
  pending = { kind: 'md', msg }
  try {
    const tab = await chrome.tabs.get(msg.tabId).catch(() => undefined)
    if (blockedIfRestricted(tab?.url)) return
    post({ type: 'OCR_STATUS', stage: 'capturing' })
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: msg.tabId },
      // Self-contained (classic script): serialize the HTML and extract the pixels
      // of READABLE images (same-origin / CORS) for hybrid OCR. Cross-origin images
      // taint the canvas and throw on toDataURL — they're skipped (keep their alt).
      func: () => {
        const MAX_IMAGES = 12
        const MIN_W = 200
        const MIN_H = 60
        const MAX_SIDE = 1400
        const images: { src: string; dataUrl: string }[] = []
        const candidates = Array.from(document.images)
          .filter((im) => im.naturalWidth >= MIN_W && im.naturalHeight >= MIN_H)
          .slice(0, MAX_IMAGES)
        for (const im of candidates) {
          try {
            const s = Math.min(1, MAX_SIDE / Math.max(im.naturalWidth, im.naturalHeight))
            const c = document.createElement('canvas')
            c.width = Math.round(im.naturalWidth * s)
            c.height = Math.round(im.naturalHeight * s)
            const cx = c.getContext('2d')
            if (!cx) continue
            cx.drawImage(im, 0, 0, c.width, c.height)
            images.push({ src: im.currentSrc || im.src, dataUrl: c.toDataURL('image/png') })
          } catch {
            /* cross-origin tainted canvas — unreadable, skip */
          }
        }
        return { html: document.body.innerHTML, title: document.title, url: location.href, images }
      },
    })
    const page = res?.result as
      | { html: string; title: string; url: string; images: { src: string; dataUrl: string }[] }
      | undefined
    if (!page) {
      pending = null
      post({ type: 'OCR_STATUS', stage: 'error', message: 'Could not read this page.' })
      return
    }
    // The panel OCRs readable images for hybrid captions — it needs the engine alive.
    if (page.images?.length) await ensureOcrHost()
    post({
      type: 'PAGE_HTML',
      html: page.html,
      title: page.title,
      url: page.url,
      images: page.images ?? [],
    })
    pending = null
  } catch (err) {
    postCaptureError(err, msg.origin)
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
