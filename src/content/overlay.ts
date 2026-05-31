// Selection overlay content script — loaded passively on every page, but inert
// until the service worker sends SHOW_OVERLAY (on action click). Draws a
// full-page dimmer + drag rectangle; on mouseup sends the selected region
// (CSS px + devicePixelRatio) to the SW, which captures & crops.

import type { CaptureRequest, Message } from '../shared/messages'

const OVERLAY_FLAG = '__ocrBuddyOverlay'

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type === 'SHOW_OVERLAY') showOverlay()
  return false
})

function showOverlay() {
  const w = window as unknown as Record<string, unknown>
  if (w[OVERLAY_FLAG]) return // already open
  w[OVERLAY_FLAG] = true

  const root = document.createElement('div')
  root.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483647',
    'cursor:crosshair',
    'background:rgba(0,0,0,0.25)',
  ].join(';')

  const box = document.createElement('div')
  box.style.cssText = [
    'position:fixed',
    'border:2px solid #4f9cff',
    'background:rgba(79,156,255,0.12)',
    'pointer-events:none',
    'display:none',
  ].join(';')
  root.appendChild(box)

  const hint = document.createElement('div')
  hint.textContent = 'Drag to select a region · Esc to cancel'
  hint.style.cssText = [
    'position:fixed',
    'top:12px',
    'left:50%',
    'transform:translateX(-50%)',
    'padding:6px 12px',
    'background:#111',
    'color:#fff',
    'font:13px system-ui,sans-serif',
    'border-radius:6px',
    'pointer-events:none',
  ].join(';')
  root.appendChild(hint)

  document.documentElement.appendChild(root)

  let startX = 0
  let startY = 0
  let dragging = false

  function teardown() {
    root.remove()
    w[OVERLAY_FLAG] = false
    document.removeEventListener('keydown', onKey)
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') teardown()
  }
  document.addEventListener('keydown', onKey)

  root.addEventListener('mousedown', (e) => {
    dragging = true
    startX = e.clientX
    startY = e.clientY
    box.style.display = 'block'
    box.style.left = `${startX}px`
    box.style.top = `${startY}px`
    box.style.width = '0px'
    box.style.height = '0px'
  })

  root.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const x = Math.min(e.clientX, startX)
    const y = Math.min(e.clientY, startY)
    box.style.left = `${x}px`
    box.style.top = `${y}px`
    box.style.width = `${Math.abs(e.clientX - startX)}px`
    box.style.height = `${Math.abs(e.clientY - startY)}px`
  })

  root.addEventListener('mouseup', (e) => {
    if (!dragging) return
    dragging = false
    const x = Math.min(e.clientX, startX)
    const y = Math.min(e.clientY, startY)
    const width = Math.abs(e.clientX - startX)
    const height = Math.abs(e.clientY - startY)

    // Hide the overlay BEFORE capture so the dimmer isn't in the screenshot.
    teardown()

    if (width < 4 || height < 4) return // accidental click, not a selection

    const capture: CaptureRequest = {
      type: 'CAPTURE_REQUEST',
      rect: { x, y, width, height },
      devicePixelRatio: window.devicePixelRatio || 1,
    }
    // Small delay lets the overlay removal paint before captureVisibleTab.
    setTimeout(() => chrome.runtime.sendMessage(capture), 50)
  })
}
