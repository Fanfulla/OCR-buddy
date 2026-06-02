# OCR Buddy

**Faithful, fully-local OCR for Chrome.** Select any region of your screen — code
in a paused video, a paragraph in a PDF, a formula, a table — and get the text
back. No server. No image ever leaves your machine. No hallucinated text.

🌐 [ocr-buddy.com](https://ocr-buddy.com) · 🧩 Chrome extension (Manifest V3) ·
🔓 Free & open source (MIT) · 🛡️ 100% local, privacy-first

---

## Demo

[![Watch demo 1 — OCR Buddy in action](https://ocr-buddy.com/assets/demo/poster1.png)](https://ocr-buddy.com/assets/demo/demo1.mp4)

[![Watch demo 2 — OCR Buddy in action](https://ocr-buddy.com/assets/demo/poster2.png)](https://ocr-buddy.com/assets/demo/demo2.mp4)

*▶ Click a thumbnail to play (videos hosted on [ocr-buddy.com](https://ocr-buddy.com)).*

---

## Why this exists

Modern OCR is dominated by large autoregressive vision-language models. They top
the benchmarks — and they **invent fluent, plausible, wrong text** the moment the
pixels get unclear. For most uses that's an annoyance. For code, numbers, prices,
IDs, or anything you intend to *trust*, a confidently-wrong transcription is worse
than no transcription at all. Those models are also far too heavy to run in a
browser tab.

OCR Buddy is built on the opposite bet: **faithfulness over fluency, and the whole
pipeline on your device.** The interesting part is that those two goals don't fight
— they point at the *same* engineering choices.

### The thesis: classic OCR, not generative OCR

Hallucination in OCR is largely **architectural**. A generative model predicts the
*next likely token*, so when the image is ambiguous it falls back on its language
prior and writes something that reads well but isn't there. The classic OCR family
— **detection + CTC recognition** — has no such prior. It transcribes the glyphs
that are actually present and, when it can't, it fails to blanks or low-confidence
output. It never makes up a sentence.

That family is also small, fast, and runs comfortably in WebAssembly/WebGPU. So:

> **In-browser** and **no-hallucination** are not a tradeoff. Both constraints
> select the same stack: PaddleOCR's **PP-OCRv5** (Apache-2.0) on **ONNX Runtime
> Web**.

Everything below follows from that one decision.

---

## How it works

```
content overlay (drag-select a region)
      │  rect + devicePixelRatio
      ▼
service worker  (coordinator only — no DOM, no model, no inference)
      │  captureVisibleTab → crop on an OffscreenCanvas → PNG data URL
      ▼
offscreen document  (cross-origin isolated, WebGPU-capable, long-lived)
      └─ PP-OCRv5 (+ pix2text-mfr for formulas) on ONNX Runtime Web
      ▼
side panel  (crop shown beside the result; low-confidence words flagged)
```

A few choices worth calling out, because each solved a concrete problem:

- **The service worker only coordinates.** MV3 service workers are ephemeral and
  have no DOM. The heavy, warm OCR engine lives in an **offscreen document** — a
  real page I keep alive, made *cross-origin isolated* (COOP/COEP) so it can use
  `SharedArrayBuffer` for multi-threaded WASM, with WebGPU as the primary backend.
- **Capture uses `chrome.tabs.captureVisibleTab`, not `<video>` frame-grabbing.**
  Grabbing a frame off a cross-origin video taints the canvas and the read fails.
  `captureVisibleTab` returns clean, composited pixels — so OCR-ing code from a
  paused YouTube video Just Works.
- **Models are bundled, not downloaded.** They ship inside the extension, so the
  tool is genuinely offline and nothing — not even a model fetch — touches the
  network at runtime.

Built with Vite + CRXJS. Requires **Chrome 124+** (WebGPU in workers).

---

## The three modes

You pick how a region should be read — and you can change your mind *after*
capturing, with the **"Read as" switcher** in the result view, which re-runs a
different mode on the same crop without re-selecting.

### 🅣 Text/Code

Plain OCR for code, prose, or any text. The journey here was mostly about
**faithfully reconstructing layout from geometry**, because the recognizer only
emits glyphs:

- The Latin recognizer's dictionary has **no space token** — so inter-word spacing
  is reconstructed from the gaps between word boxes, and blank lines in code from
  vertical gaps.
- A **per-box** recognition strategy (each detected box on its own crop) keeps real
  gaps intact; the default per-line strategy merged adjacent words ("you should" →
  "youshould").
- **Column-aware reading order** clusters boxes into columns by x-gaps and reads
  column-major, so two-column papers don't come out interleaved.
- A **Code view** rebuilds indentation from box geometry and syntax-highlights it.
- A **homoglyph fold** maps stray Greek/Cyrillic look-alikes back to Latin, and a
  tightly-scoped rule folds an `o` wedged between digits back to `0` (`4o0` → `400`)
  — without touching code identifiers like `arg0` or octal `0o755`.

### 🅕 Formula → LaTeX

The one place I *had* to use a generative model — there's no CTC equivalent that
emits structured LaTeX. That reopens the hallucination risk the whole project
avoids, so the design is built around containing it.

- Model: **[pix2text-mfr](https://huggingface.co/breezedeus/pix2text-mfr)** (MIT, a
  TrOCR-style vision encoder-decoder), bundled as a quantized ~23 MB encoder + 30 MB
  decoder, lazy-loaded only when you actually use Formula mode.
- I run it **directly on ONNX Runtime Web** (which the project already bundles)
  rather than a higher-level library: that model's ONNX export has no merged
  KV-cache decoder, which breaks the usual generation loop, so the greedy decode is
  hand-rolled (feed the full sequence each step — O(n²), but a fraction of a second
  per formula). The image preprocessing and the byte-level tokenizer decode were
  validated against a reference implementation to floating-point precision before
  shipping.
- **The guardrail is visual, not statistical.** The predicted LaTeX is rendered
  with **KaTeX right beside the source crop**, so a mismatch is obvious at a glance.
  If KaTeX can't render the output, or the decode degenerates, OCR Buddy **abstains
  and shows the crop as an image** — it never presents invented LaTeX as if it were
  read.
- **Honest limit:** this is a small local model. It's accurate on clean and
  moderately complex formulas; it can misread dense, low-resolution ones. That's the
  price of staying in-browser — and exactly why the render-beside-crop check exists.

### 🅣 Table → Markdown

A single table → a Markdown grid, reconstructed by **pure geometry** from the OCR
word boxes: rows by vertical position, columns from an x-coverage profile, each
word placed in its nearest column. No extra model. Because it keys off column
*alignment* rather than ruled lines, it handles **borderless tables** — which a
layout model reads as figures.

---

## What I tried and dropped

The thought-flow wasn't a straight line. Two experiments shipped and were then
removed, on purpose:

- **A full "Document mode"** (whole-page layout analysis with a PicoDet CDLA model)
  could parse a real paper into headings, columns, tables and equations in reading
  order. But page-layout models need a *full page* of context: on a single tight
  crop they misclassify — a standalone borderless table reads as a *Figure*, a
  cropped paragraph block gets dropped. Since the tool is used by selecting one
  region at a time, the mode was unreliable for how people actually reach for it.
  I removed it (and its 7.4 MB model) and replaced it with the focused, reliable
  single-region **Formula** and **Table** modes.
- **A high-level inference library for the formula model.** Its generation loop
  assumes a KV-cache decoder this model doesn't export, which silently corrupted the
  output. It would also have bundled a *second* copy of the ONNX runtime. Hand-rolling
  the decode on the runtime I already ship was both correct and lighter.

Keeping these out is part of the design: a small, honest tool beats a broad,
flaky one.

---

## Faithfulness, concretely

Anti-hallucination isn't a tagline here, it's the feature set:

- The **source crop is always shown beside the result**, so you can verify.
- **Per-word confidence** is exposed; low-confidence words are flagged, not silently
  trusted.
- A blank or ambiguous region yields **empty output** — never invented filler.
- Formulas are **rendered beside the crop** and **abstain to the image** when unsure.

### Accuracy

Measured with `scripts/ocr-image-test.mjs` (Node, the exact PP-OCRv5 config the
extension uses) against ground truth on real academic pages:

- A coherent **text block** (the normal "select a region" workflow) scores
  **≈ 99.9–100/100** character accuracy. On clean prose it's effectively verbatim —
  sentences, citations like `[22]`, tokens like `RoPE-2D`, all correct.
- Capturing a paragraph **and an adjacent table together** drops the score — but
  that's **reading-order** interleaving, not misrecognition; the characters are
  right, the order isn't. Selecting one region (or using Table mode for the table)
  restores it.
- **Equations and tables aren't text** — use Formula and Table modes for those;
  Text/Code mode flattens them.

In short: on the content each mode is meant for, accuracy is essentially perfect.
I don't claim "100% OCR of anything" — that would be the kind of overstatement the
project is a reaction against.

---

## Privacy

- **Nothing leaves your device.** No servers, no API calls, no telemetry. The only
  network use is downloading the extension itself from the store.
- **Models are bundled**, so even first-run inference is fully offline.
- The selection overlay is passive and does not read page content; the screenshot
  permission for a site is requested explicitly, per-site, only when needed.

---

## Develop

```bash
npm install
npm run dev        # Vite + CRXJS with HMR
npm run build      # production build → dist/
npm run typecheck

# load the unpacked extension:
#   chrome://extensions → Developer mode → Load unpacked → select dist/
```

Testing:

```bash
npm run ocr-bench                  # synthetic OCR benchmark (Node/CPU)
node scripts/ocr-image-test.mjs    # score real images in test-images/ vs ground truth
npm run verify                     # load the built extension in Chromium (Playwright)
```

---

## Models

All models are bundled in the extension (`public/models/`) and run entirely
on-device. Provenance and pinned versions are in `public/models/SOURCE.md`.

| Model | Role | Source | License |
|---|---|---|---|
| `PP-OCRv5_mobile_det_infer.onnx` (~4.7 MB) | Text detection | [ppu-paddle-ocr-models](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models) · upstream [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | Apache-2.0 |
| `latin_PP-OCRv5_mobile_rec_infer.onnx` (~8 MB) | Latin text recognition (CTC) | [ppu-paddle-ocr-models](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models) · upstream [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | Apache-2.0 |
| `mfr_decoder.onnx` (~30 MB) + tokenizer | Formula → LaTeX decoder | [breezedeus/pix2text-mfr](https://huggingface.co/breezedeus/pix2text-mfr) | MIT |
| `mfr_encoder.onnx` (~23 MB, int8) | Formula image encoder | [Brian314/pix2text-mfr-quantized](https://huggingface.co/Brian314/pix2text-mfr-quantized) | MIT |

Inference runs on [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)
(WebGPU, with multi-threaded WASM fallback), via
[ppu-paddle-ocr](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr) for the
PP-OCRv5 path.

---

## License

OCR Buddy's own source code is **MIT** (see [`LICENSE`](LICENSE)).

It bundles third-party models and libraries under their own permissive licenses —
PaddleOCR / PP-OCRv5 (**Apache-2.0**), pix2text-mfr, ppu-paddle-ocr, ONNX Runtime
and KaTeX (**MIT**), and highlight.js (**BSD-3-Clause**). All are compatible with
redistribution in an MIT project; there is **no copyleft** anywhere in the stack.
Full attribution and license texts are in
[`public/THIRD_PARTY_LICENSES.md`](public/THIRD_PARTY_LICENSES.md), which ships with
the packaged extension, and model provenance is in `public/models/SOURCE.md`.

> The copyright holder in `LICENSE` is set to "OCR Buddy contributors" — change it
> to your name or organization if you prefer.

## Acknowledgements

OCR Buddy stands on excellent open-source work: **PaddleOCR / PP-OCRv5** (Baidu /
PaddlePaddle), **pix2text-mfr** (breezedeus), **ppu-paddle-ocr** (PT. Perkasa Pilar
Utama), **ONNX Runtime** (Microsoft), **KaTeX** (Khan Academy), and **highlight.js**.
Thank you.
