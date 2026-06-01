# Bundled OCR models — provenance

## PP-OCRv5 text models — **Apache-2.0**

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

## Formula recognition (Document mode, Equation regions) — **MIT**

Maps an equation crop to LaTeX. TrOCR-style VisionEncoderDecoder; autoregressive,
so the side panel renders the LaTeX with KaTeX beside the source crop as the
faithfulness check (and abstains to the image when it can't render).

- **Model:** [breezedeus/pix2text-mfr](https://huggingface.co/breezedeus/pix2text-mfr) (MIT)
- **Encoder:** int8-quantized export from [Brian314/pix2text-mfr-quantized](https://huggingface.co/Brian314/pix2text-mfr-quantized) (MIT) — 23 MB vs 87.5 MB fp32, output validated identical on a 6-formula set.
- **Decoder + tokenizer:** from `breezedeus/pix2text-mfr` (fp32 decoder, no merged/KV-cache export).

| File | Role | Source | Size |
|---|---|---|---|
| `mfr_encoder.onnx` | DeiT image encoder (int8) | `Brian314/pix2text-mfr-quantized` `encoder_model.onnx` | 23.1 MB |
| `mfr_decoder.onnx` | TrOCR text decoder (fp32) | `breezedeus/pix2text-mfr` `decoder_model.onnx` | 30.1 MB |
| `mfr_tokenizer.json` | ByteLevel-BPE vocab (decode only) | `breezedeus/pix2text-mfr` `tokenizer.json` | 39 KB |

Preproc (TrOCR/DeiT): resize 384×384, RGB, `(v/255 − 0.5) / 0.5`. Tokens:
`decoder_start_token_id = eos = 2`. The decoder has no KV-cache, so inference is a
hand-rolled greedy loop feeding the full sequence each step (see `src/offscreen/formula.ts`).
