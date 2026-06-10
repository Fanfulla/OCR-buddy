# Test images for OCR accuracy

Drop real page images here to score **Text/Code mode** against ground truth:

- `<name>.png` (or `.jpg`) — the image to OCR.
- `<name>.txt` — the ground-truth text (optional). If present, the runner reports
  accuracy `100 − CER%`; scoring is whitespace-normalized so layout/wrapping
  differences don't penalize. One block per line or the whole text both work.

A `<lang>__` filename prefix scores that file with that language pack (latin,
en, zh, cyrillic, eslav, el, korean, th, devanagari, ta, te — mirrors
`src/offscreen/packs.ts`; packs download once into `.packs-cache/`). No prefix =
latin. `latex__*` files are Formula-mode material and are skipped by the scorer
(their ground truth lives in `.latex.txt`).

Populate / refresh the multilingual set (Wikipedia per script, docs.python.org
for code, Wikipedia math pages for LaTeX — ground truth extracted from the same
DOM node that gets screenshotted):

```bash
npm run fetch-test-images
```

Run:

```bash
node scripts/ocr-image-test.mjs                   # score every pair here
node scripts/ocr-image-test.mjs some.png [lang]   # ad-hoc: just print the OCR text
```

Images here are gitignored (may be large / copyrighted / contain personal data) —
only this README is committed.

Note: Text/Code mode is plain OCR. For equations use **Formula** mode and for
tables use **Table** mode (the line-based reading order here flattens those).
