# OCR benchmark — PP-OCRv5 mobile (latin), per-box

Date: 2026-05-31 · CPU (onnxruntime-node) · same config as the extension.

**Summary:** 20/20 exact · 21/20 within 5% CER · avg CER 0.2%

> Note: this CPU run skips the in-extension upscaling of small crops, so the low-res case is a worst case here.

| # | case | CER | expected → got |
|---|---|---|---|
| 01 | prose_light | 0.0% | `The quick brown fox jumps over the lazy dog.` → `The quick brown fox jumps over the lazy dog.` |
| 02 | prose_dark | 0.0% | `Why you should stop doing code reviews!` → `Why you should stop doing code reviews!` |
| 03 | code_python | 0.0% | `def add(a, b): ⏎     return a + b` → `def add(a, b): ⏎ return a + b` |
| 04 | code_symbols | 0.0% | `const x = arr[0]; ⏎ if (x > 1) { y--; }` → `const x = arr[0]; ⏎ if (x > 1) { y--; }` |
| 05 | numbers | 0.0% | `Order 12345 total $67.89 (-3.5%)` → `Order 12345 total $67.89 (-3.5%)` |
| 06 | punctuation | 0.0% | `Hello, world! Is this correct? Yes: it works.` → `Hello, world! Is this correct? Yes: it works.` |
| 07 | narrow_words | 4.3% | `I am a dev. A B C I O U` → `I am a dev. A B C T O U` |
| 08 | long_line | 0.0% | `Code review enables verification of new code quality.` → `Code review enables verification of new code quality.` |
| 09 | multiline | 0.0% | `First line of text. ⏎ Second line here. ⏎ Third and final line.` → `First line of text. ⏎ Second line here. ⏎ Third and final line.` |
| 10 | lowres_small | 0.0% | `small low resolution text` → `small low resolution text` |
| 11 | allcaps | 0.0% | `STOP DOING CODE REVIEWS` → `STOP DOING CODE REVIEWS` |
| 12 | italic | 0.0% | `This sentence is in italics.` → `This sentence is in italics.` |
| 13 | mono_line | 0.0% | `printf("hello %d", n);` → `printf("hello %d", n);` |
| 14 | url | 0.0% | `Visit https://example.com today` → `Visit https://example.com today` |
| 15 | accented_it | 0.0% | `Perché è così, città università.` → `Perché è così, città università.` |
| 16 | math | 0.0% | `5 + 3 = 8 and 50% off` → `5 + 3 = 8 and 50% off` |
| 17 | multi_space | 0.0% | `columns    aligned    here` → `columns ⏎ aligned ⏎ here` |
| 18 | json | 0.0% | `{"name": "ocr", "v": 2}` → `{"name": "ocr", "v": 2}` |
| 19 | inline_code | 0.0% | `Use the useState hook in React.` → `Use the useState hook in React.` |
| 20 | path | 0.0% | `C:\Users\salvo\file.txt` → `C:\Users\salvo\file.txt` |
| 21 | two_column | 0.0% | `Left column line one Left column line two Left column line three Right column line one Right column line two Right column line three` → `Left column line one ⏎ Left column line two ⏎ Left column line three ⏎ Right column line one ⏎ Right column line two ⏎ Right column line three` |
