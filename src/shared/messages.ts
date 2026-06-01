// Typed message protocol shared across all extension contexts.
//
// Flow:
//   content overlay ──CaptureRequest──► service worker
//   service worker  ──RunOcr (cropped dataURL)──► offscreen ──► worker
//   worker ──OcrStatus / OcrResult──► offscreen ──► service worker ──► side panel

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Panel → SW: user pressed "Select region"; begin a capture on the active tab. */
export interface StartSelection {
  type: 'START_SELECTION'
  /** Document mode: run layout analysis + structured assembly instead of quick OCR. */
  document?: boolean
}

/** SW → content overlay: show the selection overlay on the page. */
export interface ShowOverlay {
  type: 'SHOW_OVERLAY'
}

/** Content overlay → SW: user finished selecting a region (CSS px). */
export interface CaptureRequest {
  type: 'CAPTURE_REQUEST'
  rect: Rect
  devicePixelRatio: number
  /** Page origin, so the SW can request per-site capture permission if needed. */
  origin: string
}

/** SW → panel: capturing this tab needs the user to grant per-site permission. */
export interface NeedPermission {
  type: 'NEED_PERMISSION'
  origin: string
}

/** Panel → SW: the user granted the per-site permission; retry the capture. */
export interface PermissionGranted {
  type: 'PERMISSION_GRANTED'
}

/** SW → offscreen/worker: run OCR on this cropped image. */
export interface RunOcr {
  type: 'RUN_OCR'
  /** PNG data URL of the cropped region. */
  imageDataUrl: string
  /** v1 language scope. */
  langs: string[]
  /** 'document' runs layout analysis + structured assembly; default quick OCR. */
  mode?: 'quick' | 'document'
}

export type OcrStage =
  | 'selecting'
  | 'capturing'
  | 'preprocessing'
  | 'loading-model'
  | 'detecting'
  | 'recognizing'
  | 'done'
  | 'error'

/** Progress ping for the side panel. */
export interface OcrStatus {
  type: 'OCR_STATUS'
  stage: OcrStage
  /** 0..1 where meaningful (e.g. model download). */
  progress?: number
  message?: string
}

/** One recognized text line/word with its faithfulness signal. */
export interface OcrWord {
  text: string
  /** 0..1 model confidence. Low values are flagged, never silently trusted. */
  confidence: number
  /** Bounding box in cropped-image px, for the overlay-on-crop view. */
  box: Rect
  /** Visual line index (from the engine's line grouping) for reliable breaks. */
  line: number
}

/** One rendered block of a document-mode result, in reading order. Text-like
 *  blocks carry plain text; equations carry LaTeX + the exact source crop fed to
 *  the model, so the panel can render KaTeX beside it (the anti-hallucination
 *  check) and abstain to the image when `ok` is false. */
export type DocBlock =
  | { kind: 'heading' | 'paragraph' | 'caption'; text: string }
  | { kind: 'table'; markdown: string }
  | { kind: 'figure' }
  | { kind: 'equation'; latex: string; cropDataUrl: string; ok: boolean }

/** Final result. */
export interface OcrResult {
  type: 'OCR_RESULT'
  /** 'document' results carry a Markdown `docText`; 'quick' carry text/code/words. */
  mode: 'quick' | 'document'
  /** Prose text: lines joined naturally (reading order). */
  text: string
  /** Code view: line breaks + indentation reconstructed from box geometry. */
  codeText: string
  /** Document mode: assembled Markdown of the page (layout-driven) — for Copy. */
  docText?: string
  /** Document mode: structured blocks in reading order, for rich rendering. */
  docBlocks?: DocBlock[]
  words: OcrWord[]
  /** Which backend actually ran. */
  backend: 'webgpu' | 'wasm'
  /** The crop we OCR'd, echoed back so the panel can show source beside text. */
  imageDataUrl: string
  /** Empty result is a valid, honest answer (blank/ambiguous region). */
  empty: boolean
}

export type Message =
  | StartSelection
  | ShowOverlay
  | CaptureRequest
  | NeedPermission
  | PermissionGranted
  | RunOcr
  | OcrStatus
  | OcrResult

/** Confidence below this is rendered as "uncertain" in the UI. */
export const LOW_CONFIDENCE = 0.6
