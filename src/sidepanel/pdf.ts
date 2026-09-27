import type { PDFDocumentLoadingTask, PDFWorker, RenderTask, TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'

const MAX_BYTES = 50_000_000
const MAX_PAGES = 300

/** Preserve content order; use explicit EOLs or changes of text baseline. */
export function pdfText(items: TextContent['items']): string {
  const lines: string[] = []
  let line = ''
  let previous: TextItem | undefined
  const flush = () => {
    if (line.trim()) lines.push(line.trimEnd())
    line = ''
    previous = undefined
  }
  // ponytail: geometry is a reading-order heuristic; complex columns need tagged layout.
  for (const item of items) {
    if (!('str' in item)) continue
    if (item.str && previous) {
      const [a, b, c, d, x, y] = previous.transform
      const vertical = previous.dir === 'ttb'
      const length = Math.hypot(vertical ? c : a, vertical ? d : b) || 1
      const ux = (vertical ? -c : a) / length
      const uy = (vertical ? -d : b) / length
      const dx = item.transform[4] - x
      const dy = item.transform[5] - y
      const height = Math.max(Math.hypot(c, d), Math.hypot(item.transform[2], item.transform[3]), 1)
      const angle = Math.atan2(item.transform[1], item.transform[0]) - Math.atan2(b, a)
      if (Math.abs(dx * uy - dy * ux) > height * 0.5 || Math.cos(angle) < 0.98 || (item.dir === 'ttb') !== vertical) {
        flush()
      } else {
        const advance = vertical ? previous.height : previous.width
        const along = dx * ux + dy * uy
        const gap = Math.max(along - advance, -along - (vertical ? item.height : item.width))
        if (gap > height * 0.15 && !/\s$/u.test(line) && !/^\s/u.test(item.str)) line += ' '
      }
    }
    line += item.str
    if (item.str) previous = item
    if (item.hasEOL) flush()
  }
  flush()
  return lines.join('\n').trim()
}

export function pdfPageRange(total: number, first = 1, last = total): [number, number] {
  if (!Number.isInteger(total) || total < 1) throw new Error('The PDF contains no readable pages.')
  if (total > MAX_PAGES) throw new Error('PDFs with more than 300 pages are not supported. Split the PDF before importing it.')
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > total) {
    throw new Error(`Invalid PDF page range. Choose whole page numbers from 1 to ${total}, with the first page before or equal to the last.`)
  }
  return [first, last]
}

/** Local PDF bytes only. Progress and the returned page count refer to the selected range. */
export async function readPdf(
  data: Uint8Array,
  options: {
    signal: AbortSignal
    firstPage?: number
    lastPage?: number
    forceOcr?: boolean
    ocr: (dataUrl: string) => Promise<string>
    onProgress: (page: number, total: number) => void
  },
): Promise<{ text: string; pages: number; ocrPages: number }> {
  const { signal } = options
  signal.throwIfAborted()
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new Error('Select a non-empty local PDF file.')
  if (data.byteLength > MAX_BYTES) throw new Error('PDF files must be 50 MB or smaller.')
  // Reject invalid user input before loading PDF.js or allocating a worker.
  pdfPageRange(MAX_PAGES, options.firstPage, options.lastPage)

  let port: Worker | undefined
  let worker: PDFWorker | undefined
  let loading: PDFDocumentLoadingTask | undefined
  let renderTask: RenderTask | undefined
  let abort!: () => void
  let workerError!: () => void
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    workerError = () => reject(new Error('Could not load the bundled PDF worker. Reload the extension and try again.'))
  })
  const wait = async <T>(promise: Promise<T>): Promise<T> => {
    const value = await Promise.race([promise, interrupted])
    signal.throwIfAborted()
    return value
  }
  signal.addEventListener('abort', abort, { once: true })

  try {
    const pdfjs = await wait(import('pdfjs-dist/legacy/build/pdf.mjs'))
    const base = chrome.runtime.getURL('pdfjs/')
    // Explicit port avoids PDF.js's blob wrapper for extension-scheme worker URLs.
    port = new Worker(`${base}pdf.worker.min.mjs`, { type: 'module' })
    port.addEventListener('error', workerError)
    worker = pdfjs.PDFWorker.create({ port })
    loading = pdfjs.getDocument({
      data: data.slice(), // PDF.js transfers ownership; keep the caller's bytes reusable.
      worker,
      cMapUrl: `${base}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${base}standard_fonts/`,
      wasmUrl: `${base}wasm/`,
      iccUrl: `${base}iccs/`,
      useWorkerFetch: true,
      isEvalSupported: false,
      isImageDecoderSupported: false,
      enableXfa: false,
      stopAtErrors: true,
    })
    const pdf = await wait(loading.promise)
    const [first, last] = pdfPageRange(pdf.numPages, options.firstPage, options.lastPage)
    const pages = last - first + 1
    const sections: string[] = []
    let ocrPages = 0
    options.onProgress(0, pages)

    for (let pageNumber = first; pageNumber <= last; pageNumber++) {
      signal.throwIfAborted()
      const page = await wait(pdf.getPage(pageNumber))
      let canvas: HTMLCanvasElement | undefined
      try {
        let text = options.forceOcr ? '' : pdfText((await wait(page.getTextContent())).items)
        const needsOcr = options.forceOcr || !text.trim()
        if (needsOcr) {
          const original = page.getViewport({ scale: 1 })
          const { width, height } = original
          if (!Number.isFinite(width * height) || width <= 0 || height <= 0) {
            throw new Error(`PDF page ${pageNumber} has invalid dimensions.`)
          }
          const scale = Math.min(1800 / Math.max(width, height), Math.sqrt(4_000_000 / (width * height)))
          const viewport = page.getViewport({ scale })
          canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.min(1800, Math.ceil(viewport.width)))
          canvas.height = Math.max(1, Math.min(1800, Math.ceil(viewport.height)))
          const context = canvas.getContext('2d', { alpha: false })
          if (!context) throw new Error('Could not create a canvas for PDF OCR.')
          renderTask = page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' })
          await wait(renderTask.promise)
          renderTask = undefined
          text = await wait(options.ocr(canvas.toDataURL('image/png')))
          ocrPages++
        }
        signal.throwIfAborted()
        sections.push(`## Page ${pageNumber} (${needsOcr ? 'OCR' : 'PDF text'})\n\n${text.trim() || '[No text detected]'}`)
        options.onProgress(pageNumber - first + 1, pages)
      } finally {
        renderTask?.cancel()
        renderTask = undefined
        if (canvas) canvas.width = canvas.height = 0
        page.cleanup()
      }
    }
    signal.throwIfAborted()
    return { text: sections.join('\n\n'), pages, ocrPages }
  } finally {
    renderTask?.cancel()
    try {
      // Let PDF.js release fonts/filters before terminating its worker. Bound the
      // wait so an unresponsive worker cannot hold the Cancel action indefinitely.
      if (loading) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            loading.destroy().catch(() => {}),
            new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000) }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }
    } finally {
      signal.removeEventListener('abort', abort)
      port?.removeEventListener('error', workerError)
      try {
        worker?.destroy()
      } finally {
        port?.terminate()
      }
    }
  }
}
