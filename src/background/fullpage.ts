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
  scrollY: number
}

function readMetrics(): PageMetrics {
  return {
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    scrollY: window.scrollY,
  }
}

function scrollPage(y: number): void {
  window.scrollTo(0, y)
}

// Note: `(...a: never[]) => T` is the standard but unsound workaround for executeScript's func param, relying on the cast at the call site.
async function inject<T>(tabId: number, func: (...a: never[]) => T, ...args: unknown[]): Promise<T> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: func as (...a: unknown[]) => T,
    args,
  })
  if (!res) throw new Error('Page script injection returned no result (tab closed or navigated).')
  return res.result as T
}

/** One captureVisibleTab with a single retry on the rate-limit error. */
async function captureOnce(windowId: number): Promise<string> {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
  } catch (err) {
    if (/MAX_CAPTURE|too many|quota/i.test(String(err))) {
      await wait(1000)
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
    }
    throw err
  }
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
  const m = await inject(tabId, readMetrics)
  const step = Math.max(1, m.innerHeight - OVERLAP)
  const tiles: string[] = []
  let truncated = false

  let i = 0
  for (let y = 0; y < m.scrollHeight; y += step, i++) {
    if (i >= MAX_TILES) {
      truncated = true
      break
    }
    await inject(tabId, scrollPage, y)
    await wait(SETTLE_MS)
    tiles.push(await captureOnce(windowId))
    onProgress?.(i + 1)
  }

  await inject(tabId, scrollPage, m.scrollY) // restore
  return { tiles, truncated }
}
