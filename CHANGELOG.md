# Changelog

## 2.6.0 - 2026-09-27

### Added
- Separate viewport and full-page commands, assignable in Chrome's extension shortcuts.
- Optional area selection when clicking the toolbar icon; existing default preserved.
- Opt-in automatic copy with optional clipboard write permission and failure feedback.
- History multi-selection with chronological copy and plain-text export.
- Local PDF import with page ranges, existing-text extraction, OCR for scanned pages,
  a force-OCR option, progress and cancellation. PDF contents are not saved in history.
- Release notes on the website and bundled in the extension. The local page opens
  after a version-changing update, not first installation or browser startup.

### Changed
- Compact panel with persistent capture actions at the top and history/settings below.
- Capture checks the target tab before and after screenshots, including quota retries.
- Full-page capture waits for scroll settlement, stops at the final viewport and
  attempts to restore both scroll axes on success and failure in the original document.
- OCR work is serialized to avoid overlapping model-session changes.
- Build dependency security updates and bundled PDF.js 5.5.207 legacy assets.

### Removed
- The decorative start-screen placeholder. Existing capture modes and history remain.

### Notes
- New clipboard access is optional and requested only when automatic copy is enabled.
- PDFs are opened from local files, up to 50 MB and 300 pages. Save embedded PDFs
  from their viewer first; universal embedded-viewer access is not supported.
- For mixed text/image pages, use force OCR to include text inside images. Complex
  layouts remain best-effort; compare the result with the source.
- Existing non-Latin language packs still download only on explicit selection.
- No remote OCR, document uploads, new telemetry, or remote PDF assets.

## 2.5.6
- Refined the in-panel review prompt and introduced an earlier review invitation.

## 2.5.5 — 2026-06-16

### New
- **Capture viewport** — OCR everything currently on screen in one click, no region drag.
- **Capture full page** — scroll-capture an entire page and OCR it. Each viewport is
  OCR'd as its own tile (so text stays legible) and the tiles are merged with seam
  de-duplication. Long pages stop at a tile cap and say so; sticky headers/sidebars and
  complex multi-column layouts are best-effort.
- **Page → Markdown** — turn the current page into clean, AI-ready Markdown built from
  the page's own structure (headings, lists, links, tables, code blocks) — not OCR — with
  a preview you can copy or download as a `.md` file. Fully local; relative links are
  resolved to absolute.
- **Hybrid image OCR in Page → Markdown** — text baked into readable images is OCR'd and
  inserted after the image as a clearly-labelled blockquote (`> **Text extracted from
  image (OCR):** …`), so it's never silently merged into the prose. Cross-origin images
  can't be read (browser canvas taint) and keep just their `alt` text.

### Improved
- **Reads coloured text on light backgrounds** — red validation errors, blue links and
  other coloured text were dropped at detection (the detector is tuned for dark,
  high-contrast glyphs). A background-adaptive contrast boost now pulls them up to strong
  luminance contrast, with no effect on ordinary dark-on-light text or on dark mode.

### Fixed
- **Stale-text bug on repeated captures** — the OCR engine's result cache used a weak key
  (a hash of the image's top-left corner plus its pixel count), so two same-size captures
  with a similar top-left region (white margins, a shared toolbar, blank tiles) could
  silently return the *first* capture's text. The cache is now disabled; every capture is
  recognized fresh. This also unblocked full-page capture.

### Notes
- No new permissions. The new features reuse the existing `scripting` and `activeTab`
  permissions (to scroll the page for full-page capture and to read the page's HTML for
  Markdown export). Everything still runs entirely on your device — no server, no uploads.

## 0.2.5 — 2026-06-10
- Multilingual language packs (Chinese+Japanese, Cyrillic, East Slavic, Greek, Korean,
  Thai, Devanagari, Tamil, Telugu), capture history, direct image OCR (open/paste/drop/
  right-click), version badge + home button in the panel.
