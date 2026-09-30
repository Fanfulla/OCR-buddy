// Full-page capture orchestrator. Scrolls the target tab top→bottom, captures
// each viewport with chrome.tabs.captureVisibleTab (rate-limited, so throttled),
// and returns the tiles in scroll order. Pure coordination — OCR + merge happen
// in the offscreen document. The injected functions run IN the page; they must be
// self-contained (no closure over module scope).

// Vertical overlap between consecutive tiles (CSS px), so no text line is split
// exactly at a seam without appearing whole in a neighbour.
const OVERLAP = 100
// Hard cap on tiles to bound infinite-scroll pages.
const MAX_TILES = 20
// Pause between captures: captureVisibleTab is limited to ~2/s, and the page
// needs a paint after scrolling. 600ms gives margin over the ~500ms floor.
const SETTLE_MS = 600

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface PageMetrics {
  scrollHeight: number
  innerHeight: number
  innerWidth: number
  scrollX: number
  scrollY: number
}

function readMetrics(): PageMetrics {
  return {
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  }
}

function scrollPage(x: number, y: number): Promise<void> {
  // Native instant overrides CSS smooth scrolling for this call only. Do not
  // change the page's styles (including during an abort or navigation).
  window.scrollTo({ left: x, top: y, behavior: 'instant' })
  return new Promise((resolve, reject) => {
    let frame = 0
    let stable = 0
    const timeout = setTimeout(() => {
      cancelAnimationFrame(frame)
      reject(new Error('Page scrolling did not settle. Capture cancelled.'))
    }, 1500)
    const check = () => {
      const root = document.documentElement
      const targetX = Math.max(0, Math.min(x, root.scrollWidth - window.innerWidth))
      const targetY = Math.max(0, Math.min(y, root.scrollHeight - window.innerHeight))
      stable = Math.abs(window.scrollX - targetX) < 1 && Math.abs(window.scrollY - targetY) < 1 ? stable + 1 : 0
      if (stable >= 2) {
        clearTimeout(timeout)
        resolve()
      } else frame = requestAnimationFrame(check)
    }
    frame = requestAnimationFrame(check)
  })
}

async function inject<Args extends unknown[], T>(
  target: chrome.scripting.InjectionTarget, func: (...args: Args) => T, ...args: Args
) {
  const [res] = await chrome.scripting.executeScript({
    target,
    func,
    args,
  })
  if (!res) throw new Error('Page script injection returned no result (tab closed or navigated).')
  return res
}

/** Chrome captures a WINDOW's active tab, never a tab ID. Latch switches and
 * navigation, including switch-away-and-back during the asynchronous screenshot. */
async function withCaptureTab<T>(
  tabId: number, windowId: number,
  run: (capture: () => Promise<string>, check: () => Promise<void>) => Promise<T>,
): Promise<T> {
  let changed = false
  const activated = (info: chrome.tabs.TabActiveInfo) => {
    if (info.windowId === windowId && info.tabId !== tabId) changed = true
  }
  const updated = (id: number, info: chrome.tabs.TabChangeInfo) => {
    if (id === tabId && (info.status === 'loading' || info.url !== undefined)) changed = true
  }
  const removed = (id: number) => { if (id === tabId) changed = true }
  chrome.tabs.onActivated.addListener(activated)
  chrome.tabs.onUpdated.addListener(updated)
  chrome.tabs.onRemoved.addListener(removed)
  const check = async () => {
    const [active] = await chrome.tabs.query({ active: true, windowId })
    if (changed || active?.id !== tabId) {
      throw new Error('The capture tab changed or navigated. Return to the intended page and try again.')
    }
  }
  const capture = async () => {
    for (let attempt = 0; ; attempt++) {
      await check()
      try {
        const pixels = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
        await check() // Discard pixels if Chrome captured during a tab switch.
        return pixels
      } catch (err) {
        if (attempt !== 0 || !/MAX_CAPTURE|too many|quota/i.test(String(err))) throw err
        await wait(1000) // The next iteration checks identity again before retrying.
      }
    }
  }
  try {
    await check()
    return await run(capture, check)
  } finally {
    chrome.tabs.onActivated.removeListener(activated)
    chrome.tabs.onUpdated.removeListener(updated)
    chrome.tabs.onRemoved.removeListener(removed)
  }
}

/** Shared viewport/region screenshot guard. An overlay supplies its document ID
 * so a late selection or permission retry cannot capture a replacement page. */
export async function captureTab(tabId: number, windowId: number, documentId?: string): Promise<string> {
  return withCaptureTab(tabId, windowId, async (capture) => {
    if (documentId) await inject({ tabId, documentIds: [documentId] }, () => true)
    return capture()
  })
}

export interface FullPageResult {
  tiles: string[]
  truncated: boolean
}

/** Scroll + capture the whole page. Reports 1-based tile progress via onProgress.
 *  Restores the original scroll position when done. */
export async function captureFullPage(
  tabId: number,
  windowId: number,
  onProgress?: (tile: number) => void,
): Promise<FullPageResult> {
  return withCaptureTab(tabId, windowId, async (capture, check) => {
    const initial = await inject({ tabId }, readMetrics)
    const m = initial.result
    if (!m || m.innerHeight <= 0) throw new Error('Could not measure the capture page.')
    const target: chrome.scripting.InjectionTarget = initial.documentId
      ? { tabId, documentIds: [initial.documentId] }
      : { tabId, frameIds: [initial.frameId] }
    const tiles: string[] = []
    let y = 0
    try {
      for (let i = 0; i < MAX_TILES; i++) {
        await check()
        await inject(target, scrollPage, 0, y)
        await wait(SETTLE_MS)
        const before = (await inject(target, readMetrics)).result!
        if (Math.abs(before.scrollY - y) >= 1 || Math.abs(before.scrollX) >= 1) {
          throw new Error('Page scrolled during capture. Please try again.')
        }
        const pixels = await capture()
        const after = (await inject(target, readMetrics)).result!
        if (before.scrollY !== after.scrollY || before.scrollX !== after.scrollX ||
            before.innerHeight !== after.innerHeight || before.innerWidth !== after.innerWidth) {
          throw new Error('Page moved or resized during capture. Please try again.')
        }
        tiles.push(pixels)
        onProgress?.(tiles.length)
        // Stop on the last viewport, not scrollHeight: clamped scrolling otherwise
        // repeats bottom tiles and incorrectly marks an exactly-20-tile page cut off.
        if (after.scrollY + after.innerHeight >= after.scrollHeight - 1) return { tiles, truncated: false }
        y = Math.min(after.scrollY + Math.max(1, after.innerHeight - OVERLAP), after.scrollHeight - after.innerHeight)
      }
      return { tiles, truncated: true }
    } finally {
      // documentIds pins cleanup to the original document, even on same-URL reload.
      // A closed/navigated tab cannot be restored; never scroll its replacement.
      await inject(target, scrollPage, m.scrollX, m.scrollY).catch(() => {})
    }
  })
}
