# Test images for OCR accuracy

Drop real page images here to score **Text/Code mode** against ground truth:

- `<name>.png` (or `.jpg`) — the image to OCR.
- `<name>.txt` — the ground-truth text (optional). If present, the runner reports
  accuracy `100 − CER%`; scoring is whitespace-normalized so layout/wrapping
  differences don't penalize. One block per line or the whole text both work.

Run:

```bash
node scripts/ocr-image-test.mjs            # score every pair here
node scripts/ocr-image-test.mjs some.png   # ad-hoc: just print the OCR text
```

Images here are gitignored (may be large / copyrighted / contain personal data) —
only this README is committed.

Note: Text/Code mode is plain OCR. For equations use **Formula** mode and for
tables use **Table** mode (the line-based reading order here flattens those).
