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

🟡 **Engine wired — runtime unverified.** The full pipeline is implemented: the
offscreen document hosts [`ppu-paddle-ocr`](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr)
(PP-OCRv5, Apache-2.0) on ONNX Runtime Web, with the three model files bundled in
`public/models/` (see `public/models/SOURCE.md`) and the ORT wasm self-hosted under
`dist/ort/`. `npm run build` + `npm run typecheck` are green.

**Not yet confirmed in a browser** — load `dist/` unpacked (Chrome 124+) and check the
offscreen console (`chrome://extensions` → OCR Buddy → *Inspect views: offscreen.html*)
for `crossOriginIsolated === true`, no wasm 404s under `/ort/`, and a non-empty
recognition result. Note: a tab open *before* the extension loads must be reloaded
once for the selection overlay to attach.

Known size caveat: Vite also emits a hashed copy of the ~26 MB WebGPU wasm in
`assets/` (alongside the self-hosted `dist/ort/` copy). Harmless at runtime
(`wasmPaths` points at `dist/ort/`); trimming is a later optimization.

## Develop

```bash
npm install
npm run dev      # Vite + CRXJS, HMR
# load the built dir in chrome://extensions (Developer mode → Load unpacked → dist/)
npm run build
npm run typecheck
```

Requires Chrome 124+ (WebGPU in workers).
