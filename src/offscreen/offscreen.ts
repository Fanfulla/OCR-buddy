// Offscreen document = the warm, long-lived host for the OCR worker.
// It owns ONE dedicated worker (model loaded once, reused across captures) and
// bridges messages between the worker and the rest of the extension.

import type { Message, RunOcr } from '../shared/messages'

// Vite/CRXJS resolves this `new Worker(new URL(...))` form and bundles the worker.
const worker = new Worker(new URL('../worker/ocr.worker.ts', import.meta.url), {
  type: 'module',
})

// Worker → (offscreen relay) → side panel / SW.
worker.addEventListener('message', (e: MessageEvent<Message>) => {
  chrome.runtime.sendMessage(e.data)
})

// SW → offscreen → worker.
chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type === 'RUN_OCR') {
    worker.postMessage(msg satisfies RunOcr)
  }
  return false
})
