# Bundled OCR models — provenance

All files are PP-OCRv5 mobile ONNX exports, **Apache-2.0 licensed**.

- **Source repo:** [PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models)
- **Commit pinned:** `3a180da5b1a3bab3371d970f4da42cb9b354a9a7` (downloaded 2026-05-31)
- **License:** Apache-2.0 (repo `LICENSE`)
- **Upstream model authorship:** PaddlePaddle / PaddleOCR (PP-OCRv5), also Apache-2.0.

| File | Role | Source path (in repo) | Size |
|---|---|---|---|
| `PP-OCRv5_mobile_det_infer.onnx` | text detection (DBNet, shared) | `detection/PP-OCRv5_mobile_det_infer.onnx` | 4.75 MB |
| `latin_PP-OCRv5_mobile_rec_infer.onnx` | recognition (Latin: IT/FR/DE/ES + ~40 langs) | `recognition/multi/latin/v5/latin_PP-OCRv5_mobile_rec_infer.onnx` | 8.07 MB |
| `ppocrv5_latin_dict.txt` | CTC character dictionary for the Latin recognizer | `recognition/multi/latin/v5/ppocrv5_latin_dict.txt` | 2.6 KB |

ONNX binaries are Git LFS-backed upstream; fetch via the LFS media endpoint
(`https://media.githubusercontent.com/media/.../<path>`), not the plain raw URL
(which returns the LFS pointer text).

To update: re-download the same paths at a newer commit, update the SHA above,
and re-verify Apache-2.0 + tensor IO (Netron).
