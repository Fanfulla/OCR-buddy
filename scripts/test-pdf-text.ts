import assert from 'node:assert/strict'
import { pdfPageRange, pdfText, readPdf } from '../src/sidepanel/pdf.ts'

const item = (str: string, x: number, y: number, width = str.length * 5, hasEOL = false) => ({
  str, dir: 'ltr', width, height: 10, transform: [10, 0, 0, 10, x, y], fontName: 'test', hasEOL,
})

assert.equal(pdfText([item('Hel', 0, 100, 15), item('lo', 15, 100, 10), item('world', 28, 100)]), 'Hello world')
assert.equal(pdfText([item('First', 0, 100), item('Second', 0, 85)]), 'First\nSecond')
assert.equal(pdfText([item('First', 0, 100, 25, true), item('Second', 30, 100)]), 'First\nSecond')
assert.equal(pdfText([item('First', 0, 100), item('', 25, 100, 0, true), item('Second', 0, 100)]), 'First\nSecond')
assert.equal(pdfText([item('Hello ', 0, 100, 30), item('world', 33, 100)]), 'Hello world')
assert.equal(pdfText([{ ...item('שלום', 40, 100, 20), dir: 'rtl' }, item('123', 20, 100, 15)]), 'שלום 123')
assert.equal(pdfText([{ type: 'beginMarkedContent' }, item('A', 0, 100), { type: 'endMarkedContent' }]), 'A')
assert.equal(pdfText([item(' ', 0, 100), item('', 0, 90, 0, true)]), '')
assert.equal(pdfText([
  { ...item('Up', 100, 0, 10), transform: [0, 10, -10, 0, 100, 0] },
  { ...item('ward', 100, 10, 20), transform: [0, 10, -10, 0, 100, 10] },
  { ...item('Next', 85, 0, 20), transform: [0, 10, -10, 0, 85, 0] },
]), 'Upward\nNext')

assert.deepEqual(pdfPageRange(3), [1, 3])
assert.deepEqual(pdfPageRange(3, 2, 3), [2, 3])
assert.deepEqual(pdfPageRange(300, 300), [300, 300])
for (const [first, last] of [[0, 2], [2, 1], [1, 4], [1.5, 2], [1, NaN]]) {
  assert.throws(() => pdfPageRange(3, first, last), /Invalid PDF page range/)
}
assert.throws(() => pdfPageRange(301, 1, 1), /more than 300 pages/)
assert.throws(() => pdfPageRange(0), /no readable pages/)

const options = {
  signal: new AbortController().signal,
  ocr: async () => { throw new Error('OCR must not run for invalid input') },
  onProgress: () => { throw new Error('Progress must not run for invalid input') },
}
await assert.rejects(readPdf(new Uint8Array(), options), /non-empty local PDF/)
await assert.rejects(readPdf('https://example.invalid/file.pdf' as unknown as Uint8Array, options), /local PDF/)
await assert.rejects(readPdf(new Uint8Array(50_000_001), options), /50 MB/)
await assert.rejects(readPdf(new Uint8Array([1]), { ...options, firstPage: 0 }), /Invalid PDF page range/)
const aborted = new AbortController()
aborted.abort()
await assert.rejects(readPdf(new Uint8Array([1]), { ...options, signal: aborted.signal }), { name: 'AbortError' })

console.log('PDF text, ranges, input limits, and pre-aborted import: all assertions passed')
