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

/** Capture modes: quick OCR, a single formula → LaTeX, or a single table → Markdown. */
export type CaptureMode = 'quick' | 'formula' | 'table'

/** Panel → SW: user pressed "Select region"; begin a capture on the active tab. */
export interface StartSelection {
  type: 'START_SELECTION'
  /** Which pipeline to run on the captured region (default 'quick'). */
  mode?: CaptureMode
}

/** SW → content overlay: show the selection overlay on the page. */
export interface ShowOverlay {
  type: 'SHOW_OVERLAY'
  /** Echoed back in CAPTURE_REQUEST, so the mode survives an MV3 service-worker
   *  restart between selection start and mouseup (no in-memory SW state). */
  mode: CaptureMode
}

/** Content overlay → SW: user finished selecting a region (CSS px). */
export interface CaptureRequest {
  type: 'CAPTURE_REQUEST'
  rect: Rect
  devicePixelRatio: number
  /** Page origin, so the SW can request per-site capture permission if needed. */
  origin: string
  /** Capture mode chosen at selection time (echoed from SHOW_OVERLAY). */
  mode: CaptureMode
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

/** SW → panel: this page can NEVER be captured (Chrome Web Store, chrome:// …).
 *  Distinct from NEED_PERMISSION — no host grant can unblock it, so the panel shows
 *  an honest dead-end instead of the futile "Enable for this site" prompt. */
export interface Restricted {
  type: 'RESTRICTED'
  /** Human phrase naming the page class, e.g. "the Chrome Web Store". */
  reason: string
}

/** Panel → SW: re-run a DIFFERENT mode on the already-captured crop (no re-select).
 *  Lets the user reinterpret the same region as text / document / formula / table. */
export interface Reprocess {
  type: 'REPROCESS'
  imageDataUrl: string
  mode: CaptureMode
}

/** Panel → SW: capture the whole visible viewport (no region selection), then OCR. */
export interface CaptureViewport {
  type: 'CAPTURE_VIEWPORT'
  /** Which pipeline to run; viewport is a single image so all modes are valid. */
  mode: CaptureMode
  /** Page origin, so the SW can request per-site capture permission if needed. */
  origin: string
}

/** Panel → SW: capture the full scrollable page, OCR each tile, merge the text.
 *  Always runs the quick pipeline (table/formula across page tiles is incoherent). */
export interface CaptureFullPage {
  type: 'CAPTURE_FULLPAGE'
  /** The tab to capture — resolved by the panel at click time so a later tab
   *  switch can't redirect injection/capture to the wrong tab. */
  tabId: number
  /** Page origin, so the SW can request per-site capture permission if needed. */
  origin: string
}

/** Panel → SW: extract the page's full DOM as Markdown (no OCR — reads structure). */
export interface ConvertPageMd {
  type: 'CONVERT_PAGE_MD'
  /** The tab to read — resolved by the panel at click time. */
  tabId: number
  /** Page origin, so the SW can request per-site permission if needed. */
  origin: string
}

/** A readable page image (same-origin / CORS-enabled), captured for hybrid OCR. */
export interface PageImage {
  /** The element's resolved src — used to match it back into the HTML. */
  src: string
  /** PNG data URL of the image's pixels (only present when readable). */
  dataUrl: string
}

/** SW → panel: the page's raw HTML + readable images, for the panel to convert to
 *  Markdown locally (and OCR the images for hybrid captions). */
export interface PageHtml {
  type: 'PAGE_HTML'
  html: string
  title: string
  url: string
  /** Readable images to OCR for captions (cross-origin ones are omitted). */
  images: PageImage[]
}

/** Panel → offscreen: OCR a batch of images; texts come back index-aligned. */
export interface RunOcrImages {
  type: 'RUN_OCR_IMAGES'
  imageDataUrls: string[]
  lang?: string
}

/** offscreen → panel: per-image OCR text, index-aligned with RunOcrImages. */
export interface PageImagesOcr {
  type: 'PAGE_IMAGES_OCR'
  texts: string[]
}

/** SW → offscreen: OCR a batch of full-page tiles (top→bottom) and merge into one
 *  text result. */
export interface RunOcrTiles {
  type: 'RUN_OCR_TILES'
  /** PNG data URLs, one per captured viewport, in scroll order. */
  imageDataUrls: string[]
  /** Language pack id; default = bundled Latin. */
  lang?: string
  /** True when the tile cap was hit and the page was only partly captured. */
  truncated?: boolean
}

/** SW → offscreen/worker: run OCR on this cropped image. */
export interface RunOcr {
  type: 'RUN_OCR'
  /** PNG data URL of the cropped region. */
  imageDataUrl: string
  /** Language pack id (src/offscreen/packs.ts); default = bundled Latin. */
  lang?: string
  /** Which pipeline to run; default quick OCR. */
  mode?: CaptureMode
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

/** A rendered block of a Table-mode result: the reconstructed grid as Markdown,
 *  or a plain-text fallback when the crop isn't grid-like. */
export type DocBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'table'; markdown: string }

/** Final result. */
export interface OcrResult {
  type: 'OCR_RESULT'
  /** 'table' carries docText/docBlocks; 'formula' carries latex; 'quick' text/code/words. */
  mode: CaptureMode
  /** Prose text: lines joined naturally (reading order). */
  text: string
  /** Code view: line breaks + indentation reconstructed from box geometry. */
  codeText: string
  /** Table mode: the reconstructed grid as Markdown — for Copy. */
  docText?: string
  /** Table mode: structured block(s) for rich rendering (grid, or text fallback). */
  docBlocks?: DocBlock[]
  /** Formula mode: the recognized LaTeX. */
  latex?: string
  /** Formula mode: false = degenerate/empty decode → panel abstains to the crop. */
  latexOk?: boolean
  words: OcrWord[]
  /** Which backend actually ran. */
  backend: 'webgpu' | 'wasm'
  /** The crop we OCR'd, echoed back so the panel can show source beside text. */
  imageDataUrl: string
  /** Empty result is a valid, honest answer (blank/ambiguous region). */
  empty: boolean
  /** Optional non-error caption (e.g. full-page capture was truncated). */
  note?: string
}

export type Message =
  | StartSelection
  | ShowOverlay
  | CaptureRequest
  | CaptureViewport
  | CaptureFullPage
  | ConvertPageMd
  | PageHtml
  | RunOcrImages
  | PageImagesOcr
  | NeedPermission
  | PermissionGranted
  | Restricted
  | Reprocess
  | RunOcr
  | RunOcrTiles
  | OcrStatus
  | OcrResult

/** Confidence below this is rendered as "uncertain" in the UI. */
export const LOW_CONFIDENCE = 0.6

/** Side-panel preferences persisted in chrome.storage.local. Shared so the
 *  service worker can honour the last-used capture mode on the keyboard
 *  shortcut path (the panel may not have broadcast a mode yet). */
export const PREFS_KEY = 'sidepanel.prefs'
export interface PanelPrefs {
  captureMode?: CaptureMode
  codeMode?: boolean
  /** Language pack id (src/offscreen/packs.ts); default = bundled Latin. */
  lang?: string
  /** Save captures to local history (default true; stored on-device only). */
  history?: boolean
}
