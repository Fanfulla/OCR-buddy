// Real PDF worker + local OCR, using synthetic documents and no HTTP requests.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

function samplePdf(jpeg) {
  const stream = (data, dict = '') => Buffer.concat([Buffer.from(`<< /Length ${data.length} ${dict} >>\nstream\n`), data, Buffer.from('\nendstream')])
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /XObject << /Im1 7 0 R >> >> /Contents 8 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    stream(Buffer.from('BT /F1 32 Tf 40 300 Td (LOCAL PDF ONE) Tj ET')),
    stream(jpeg, '/Type /XObject /Subtype /Image /Width 1000 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode'),
    stream(Buffer.from('q 600 0 0 240 0 80 cm /Im1 Do Q')),
  ]
  const chunks = [Buffer.from('%PDF-1.4\n')]
  const offsets = [0]
  let length = chunks[0].length
  objects.forEach((obj, i) => {
    offsets.push(length)
    const block = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), obj, Buffer.from('\nendobj\n')])
    chunks.push(block); length += block.length
  })
  const xref = offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`))
  return Buffer.concat(chunks)
}

const profile = mkdtempSync(path.resolve('.pw-pdf-'))
const dist = path.resolve('dist')
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, viewport: { width: 400, height: 850 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run'],
})
const network = []
await ctx.route(/^https?:/, (route) => { network.push(route.request().url()); return route.abort() })
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker')
  const root = `chrome-extension://${new URL(sw.url()).host}`
  const panel = await ctx.newPage()
  const errors = []
  panel.on('pageerror', (e) => errors.push(e.message))
  panel.on('console', (m) => { if (m.type() === 'error') console.log('PDF console:', m.text()) })
  await panel.goto(`${root}/src/sidepanel/index.html`)
  const dataUrl = await panel.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1000; canvas.height = 400
    const c = canvas.getContext('2d')
    c.fillStyle = '#fff'; c.fillRect(0, 0, 1000, 400)
    c.fillStyle = '#000'; c.font = '54px Arial'
    c.fillText('SCANNED PAGE SEVEN', 45, 200)
    return canvas.toDataURL('image/jpeg', 0.95)
  })
  const buffer = samplePdf(Buffer.from(dataUrl.split(',')[1], 'base64'))
  await panel.locator('#pdf-input').setInputFiles({ name: 'local-test.pdf', mimeType: 'application/pdf', buffer })
  await panel.locator('#pdf-read').click()
  await panel.waitForFunction(() => /^(Read |Could not read PDF:)/.test(document.getElementById('pdf-progress').textContent), null, { timeout: 90000 })
  const progress = await panel.locator('#pdf-progress').textContent()
  const text = await panel.locator('#pdf-text').textContent()
  console.log('PDF progress:', progress)
  console.log('PDF text:', text)
  assert.match(progress, /Read 2 pages \(1 with OCR\)/)
  assert.match(text, /Page 1 \(PDF text\)[\s\S]*LOCAL PDF ONE/)
  assert.match(text, /Page 2 \(OCR\)[\s\S]*SCANNED PAGE SEVEN/)
  assert.equal(await panel.evaluate(() => chrome.storage.local.get('history.v1').then((x) => x['history.v1']?.length ?? 0)), 0)

  await panel.locator('#pdf-last').fill('1')
  await panel.locator('#pdf-read').click()
  await panel.waitForFunction(() => document.getElementById('pdf-progress').textContent.startsWith('Read 1 pages'))
  assert.match(await panel.locator('#pdf-progress').textContent(), /0 with OCR/)
  assert.doesNotMatch(await panel.locator('#pdf-text').textContent(), /Page 2/)

  await panel.locator('#pdf-force-ocr').check()
  await panel.locator('#pdf-read').click()
  await panel.waitForFunction(() => document.getElementById('pdf-progress').textContent.startsWith('Read 1 pages'), null, { timeout: 60000 })
  assert.match(await panel.locator('#pdf-progress').textContent(), /1 with OCR/)
  assert.match(await panel.locator('#pdf-text').textContent(), /LOCAL PDF ONE/)

  await panel.locator('#pdf-first').fill('3')
  await panel.locator('#pdf-read').click()
  await panel.waitForFunction(() => document.getElementById('pdf-progress').textContent.startsWith('Could not read PDF:'))
  assert.equal(await panel.locator('#pdf-copy').isEnabled(), false)
  assert.equal(await panel.locator('#pdf-text').textContent(), '')

  await panel.locator('#pdf-first').fill('1')
  await panel.locator('#pdf-last').fill('')
  await panel.locator('#pdf-read').click()
  await panel.locator('#pdf-cancel').click()
  await panel.waitForFunction(() => document.getElementById('pdf-progress').textContent.startsWith('Cancelled.'))
  assert.equal(await panel.locator('#pdf-copy').isEnabled(), false)
  assert.equal(await panel.locator('#select-btn').isEnabled(), true)
  assert.deepEqual(errors, [])
  assert.deepEqual(network, [], 'local PDF reading attempted an external request')
  console.log('PDF: PASS (native text, scanned page, forced OCR, range, cancel, no HTTP requests)')
} finally {
  await ctx.close()
}
