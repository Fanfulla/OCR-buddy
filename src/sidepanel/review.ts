// Chrome Web Store review prompt: a quiet fixed link + a gentle, growing-gap nudge.
// We can't submit a star rating from inside the extension (no CWS URL parameter for
// it), so any star click just opens the reviews page; copy says so. The nudge cadence
// is pure and unit-tested; storage and DOM are thin wrappers around it.

export const REVIEW_URL =
  'https://chromewebstore.google.com/detail/ocr-buddy/hfbghdhendbnblgnjgkfmpgokiiddlhj/reviews'

export const THANKS_COPY = "Thanks, you're the best ★"

/** Successful captures between consecutive nudges; the cycle repeats forever. */
const GAPS = [10, 15, 30]

export interface ReviewState {
  successCount: number
  nudgeCount: number
  rated: boolean
}

const REVIEW_KEY = 'review.v1'
const DEFAULT_STATE: ReviewState = { successCount: 0, nudgeCount: 0, rated: false }

/** Total successful captures needed before the (nudgeCount-th, 0-indexed) nudge:
 *  the sum of the first nudgeCount+1 gaps of the repeating cycle. */
export function thresholdFor(nudgeCount: number): number {
  let total = 0
  for (let i = 0; i <= nudgeCount; i++) total += GAPS[i % GAPS.length]
  return total
}

export function shouldShowNudge(s: ReviewState): boolean {
  return !s.rated && s.successCount >= thresholdFor(s.nudgeCount)
}

async function loadState(): Promise<ReviewState> {
  try {
    const got = await chrome.storage.local.get(REVIEW_KEY)
    return { ...DEFAULT_STATE, ...(got[REVIEW_KEY] as Partial<ReviewState> | undefined) }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

async function saveState(s: ReviewState): Promise<void> {
  try {
    await chrome.storage.local.set({ [REVIEW_KEY]: s })
  } catch {
    /* storage unavailable — review nudging is best-effort */
  }
}

/** Record one successful capture. If it crosses the next nudge threshold, spend the
 *  nudge (advance the cycle) and return the new success count (for the copy);
 *  otherwise return null. */
export async function recordSuccessAndMaybeNudge(): Promise<number | null> {
  const s = await loadState()
  if (s.rated) return null
  s.successCount += 1
  const show = shouldShowNudge(s)
  if (show) s.nudgeCount += 1
  await saveState(s)
  return show ? s.successCount : null
}

/** Open the reviews tab and mark the user rated (never nudge again). */
export async function openReview(): Promise<void> {
  void chrome.tabs.create({ url: REVIEW_URL })
  const s = await loadState()
  s.rated = true
  await saveState(s)
}

export async function hasRated(): Promise<boolean> {
  return (await loadState()).rated
}

/** Build a 5-star widget. The gold fill-up-to-cursor is pure CSS; this wires the
 *  click + keyboard activation. Any activation calls `onActivate` (→ openReview). */
export function renderStars(onActivate: () => void): HTMLElement {
  const row = document.createElement('div')
  row.className = 'stars'
  row.setAttribute('role', 'button')
  row.tabIndex = 0
  row.setAttribute('aria-label', 'Rate OCR Buddy on the Chrome Web Store')
  for (let i = 0; i < 5; i++) {
    const star = document.createElement('span')
    star.className = 'star'
    star.style.setProperty('--i', String(i)) // stagger the entrance
    star.textContent = '★'
    row.appendChild(star)
  }
  row.addEventListener('click', onActivate)
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onActivate()
    }
  })
  return row
}
