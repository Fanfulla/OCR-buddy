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
      └─ ppu-paddle-ocr · PP-OCRv5 on ONNX Runtime Web  ── text + confidence
      ▼
side panel (crop shown beside editable text; low-confidence words flagged)
```

- **Service worker** = coordinator only (no DOM, no model, no inference).
- **Offscreen document** = the long-lived host that runs the warm OCR engine.
- **Capture** uses `chrome.tabs.captureVisibleTab` (taint-free even over cross-origin
  video) — *not* `<video>`-frame grabbing, which the cross-origin canvas taint blocks.

## v1 scope

- Languages: **Latin + Italian/EU** (abstains rather than transliterate-hallucinating on others).
- **Super-resolution** preprocessing for low-res video frames.
- Backend: **WebGPU primary, multi-threaded WASM fallback**.
- Guardrails as the headline feature: confidence flags, empty output on blank regions.

## Status

🟢 **Engine verified in a real MV3 extension.** The offscreen document hosts
[`ppu-paddle-ocr`](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr)
(PP-OCRv5, Apache-2.0) on ONNX Runtime Web, with the three model files bundled in
`public/models/` (see `public/models/SOURCE.md`) and the ORT wasm self-hosted under
`dist/ort/`. Build + typecheck green.

`npm run verify` loads the built extension in Chromium (Playwright) and runs the real
engine on a bundled test image. Confirmed: `crossOriginIsolated === true`, **WebGPU**
backend active, and faithful output — `"OCR Buddy 2026 const x = 42;"` extracted
exactly (symbols and digits intact, nothing invented). The `src/testbed/` page is the
harness it drives.

Notes:
- A tab open *before* the extension loads must be reloaded once for the selection
  overlay to attach (the service worker shows a friendly message otherwise).
- `npm run verify` must run headed (Playwright only loads extensions headed) and uses
  bundled Chromium because an org-managed system Chrome may block `--load-extension`.
- Size caveat: Vite also emits a hashed copy of the ~26 MB WebGPU wasm in `assets/`
  (alongside `dist/ort/`). Harmless at runtime (`wasmPaths` points at `dist/ort/`);
  trimming is a later optimization.

`npm run verify:ux` drives the **full capture→panel flow** in Chromium: serves a
local page, fires the overlay, drag-selects with a real mouse, and reads the result
from the side panel. Confirmed end-to-end (`"HELLO OCR 7"` round-tripped, WebGPU).
Caveat: this test loads a copy of `dist/` with `host_permissions` added so
`captureVisibleTab` is authorized without a toolbar click (Playwright can't click the
browser action) — production keeps `activeTab`, granted by the real click.

Implemented since: **smart upscaling** of small crops (low-res video lever) and a
**code view** that reconstructs indentation from box geometry (toggle in the panel,
default off). Both checked by `npm run verify`.

Deferred: an optional ML super-resolution model; richer intra-line spacing; moving
inference to a dedicated worker.

## Develop

```bash
npm install
npm run dev      # Vite + CRXJS, HMR
# load the built dir in chrome://extensions (Developer mode → Load unpacked → dist/)
npm run build
npm run typecheck
```

Requires Chrome 124+ (WebGPU in workers).
