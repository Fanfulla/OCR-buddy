# OCR Buddy

A Chrome extension (Manifest V3) that does **faithful, fully-local OCR**. Select a
region on screen — code in a paused video, a document, a photo — and get the text,
with **no server, no images leaving your machine, and no hallucinated text**.

## Why it's different

Most OCR tools today are large autoregressive vision-language models. They top the
benchmarks but **invent fluent, plausible, wrong text** when the pixels are unclear —
and they're too heavy to run in a browser. OCR Buddy deliberately uses the *classic*
family — **detection + CTC recognition (PaddleOCR PP-OCRv5, Apache-2.0)** — which:

- transcribes glyphs that are actually present (fails to blanks/garbage, never fabricates),
- runs **100% in-browser** via ONNX Runtime Web (WebGPU, WASM fallback),
- exposes **per-word confidence** so uncertain output is flagged, not trusted silently.

The full research behind these choices is in [`research/`](./research/) — start with
[`OCR_BUDDY_RESEARCH.md`](./research/OCR_BUDDY_RESEARCH.md).

## Architecture

```
content overlay (drag-select)
      │ rect + devicePixelRatio
      ▼
service worker (coordinator)  ── captureVisibleTab → crop on OffscreenCanvas
      │ cropped PNG
      ▼
offscreen document (cross-origin isolated, WebGPU-capable)
      └─ dedicated worker: PP-OCRv5 on ONNX Runtime Web  ── text + confidence
      ▼
side panel (crop shown beside editable text; low-confidence words flagged)
```

- **Service worker** = coordinator only (no DOM, no model, no inference).
- **Offscreen document** = the long-lived host that owns the warm model + worker.
- **Capture** uses `chrome.tabs.captureVisibleTab` (taint-free even over cross-origin
  video) — *not* `<video>`-frame grabbing, which the cross-origin canvas taint blocks.

## v1 scope

- Languages: **Latin + Italian/EU** (abstains rather than transliterate-hallucinating on others).
- **Super-resolution** preprocessing for low-res video frames.
- Backend: **WebGPU primary, multi-threaded WASM fallback**.
- Guardrails as the headline feature: confidence flags, empty output on blank regions.

## Status

🚧 **Scaffold.** Extension shell, capture, messaging, offscreen host, and UI are
wired end-to-end. The PP-OCRv5 inference pipeline in `src/worker/ocr.worker.ts` is
stubbed — each step is a marked `TODO`.

## Develop

```bash
npm install
npm run dev      # Vite + CRXJS, HMR
# load the built dir in chrome://extensions (Developer mode → Load unpacked → dist/)
npm run build
npm run typecheck
```

Requires Chrome 124+ (WebGPU in workers).
