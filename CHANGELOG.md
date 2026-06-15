# Changelog

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
