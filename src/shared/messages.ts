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

/** SW → content overlay: user clicked the action; show the selection overlay. */
export interface ShowOverlay {
  type: 'SHOW_OVERLAY'
}

/** Content overlay → SW: user finished selecting a region (CSS px). */
export interface CaptureRequest {
  type: 'CAPTURE_REQUEST'
  rect: Rect
  devicePixelRatio: number
}

/** SW → offscreen/worker: run OCR on this cropped image. */
export interface RunOcr {
  type: 'RUN_OCR'
  /** PNG data URL of the cropped region. */
  imageDataUrl: string
  /** v1 language scope. */
  langs: string[]
}

export type OcrStage =
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
}

/** Final result. */
export interface OcrResult {
  type: 'OCR_RESULT'
  /** Reconstructed full text (reading order). */
  text: string
  words: OcrWord[]
  /** Which backend actually ran. */
  backend: 'webgpu' | 'wasm'
  /** The crop we OCR'd, echoed back so the panel can show source beside text. */
  imageDataUrl: string
  /** Empty result is a valid, honest answer (blank/ambiguous region). */
  empty: boolean
}

export type Message = ShowOverlay | CaptureRequest | RunOcr | OcrStatus | OcrResult

/** Confidence below this is rendered as "uncertain" in the UI. */
export const LOW_CONFIDENCE = 0.6
