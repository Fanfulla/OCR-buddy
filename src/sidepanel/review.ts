// Chrome Web Store review prompt: a quiet fixed link + a gentle, growing-gap nudge.
// We can't submit a star rating from inside the extension (no CWS URL parameter for
// it), so any star click just opens the reviews page; copy says so. The nudge cadence
// is pure and unit-tested; storage and DOM are thin wrappers around it.

export const REVIEW_URL =
  'https://chromewebstore.google.com/detail/ocr-buddy/hfbghdhendbnblgnjgkfmpgokiiddlhj/reviews'

/** The first nudge comes early (5 captures) to catch engaged users; after that a
 *  growing cycle keeps later asks well-spaced so they never nag. */
const FIRST_GAP = 5
const CYCLE = [10, 15, 30]

export interface ReviewState {
  successCount: number
  nudgeCount: number
  rated: boolean
}

const REVIEW_KEY = 'review.v1'
const DEFAULT_STATE: ReviewState = { successCount: 0, nudgeCount: 0, rated: false }

/** Total successful captures needed before the (nudgeCount-th, 0-indexed) nudge:
 *  the early first gap, then the repeating cycle for each subsequent nudge.
 *  Thresholds: 5, 15, 30, 60, 70, 85, 115, … */
export function thresholdFor(nudgeCount: number): number {
  let total = FIRST_GAP
  for (let i = 1; i <= nudgeCount; i++) total += CYCLE[(i - 1) % CYCLE.length]
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

/** Open the Chrome Web Store reviews page in a new tab. Pure action, no state change
 *  — the always-on idle link uses this so it stays usable every session. */
export function openReviewPage(): void {
  void chrome.tabs.create({ url: REVIEW_URL })
}

/** Stop the periodic nudge for good. Called only when the user acts on the NUDGE
 *  itself (the thing that nags) — not the always-on idle link. */
export async function markRated(): Promise<void> {
  const s = await loadState()
  s.rated = true
  await saveState(s)
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
