// End-to-end UX verification: drives the REAL capture→panel flow.
// Serves a local page with known text, fires the overlay (as the action click
// does), drag-selects the text with a real mouse, lets the service worker
// capture+crop and the offscreen engine recognize, then reads the result from
// the side panel page. This exercises overlay timing, captureVisibleTab cropping,
// devicePixelRatio scaling, and the message wiring — none of which the engine
// testbed touches.
//
//   node scripts/verify-ux.mjs
//
import { chromium } from 'playwright'
import http from 'node:http'
import path from 'node:path'
import { rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'

const PAGE = `<!doctype html><html><body style="margin:0;background:#fff;font-family:Arial">
<h1 id="t" style="position:absolute;left:100px;top:120px;font-size:52px;margin:0;color:#000">HELLO OCR 7</h1>
</body></html>`

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(PAGE)
})
await new Promise((r) => server.listen(0, r))
const port = server.address().port
const url = `http://localhost:${port}/`

// Test build: a copy of dist with host_permissions added, so captureVisibleTab
// works WITHOUT the activeTab grant that only a real toolbar click provides
// (Playwright can't click the browser action). Production keeps activeTab; this
// only changes HOW capture is authorized, not the capture/crop/recognize path.
const dist = path.resolve('dist')
const distTest = path.resolve('dist-test')
rmSync(distTest, { recursive: true, force: true })
cpSync(dist, distTest, { recursive: true })
{
  const mf = path.join(distTest, 'manifest.json')
  const m = JSON.parse(readFileSync(mf, 'utf8'))
  m.host_permissions = ['<all_urls>']
  writeFileSync(mf, JSON.stringify(m, null, 2))
}

const profile = path.resolve('.pw-ux')
rmSync(profile, { recursive: true, force: true })

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1280, height: 720 },
  args: [`--disable-extensions-except=${distTest}`, `--load-extension=${distTest}`, '--no-first-run'],
})

try {
  let sw = ctx.serviceWorkers()[0]
  for (let i = 0; i < 20 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    sw = ctx.serviceWorkers()[0]
  }
  if (!sw) throw new Error('no service worker')
  const extId = new URL(sw.url()).host
  console.log('extensionId =', extId)

  // Side panel opened as a normal tab — it listens for OCR_RESULT and renders.
  const panel = await ctx.newPage()
  panel.on('console', (m) => console.log('  [panel]', m.text()))
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`)

  // The page under test (content script injects on http://*).
  const page = await ctx.newPage()
  page.on('console', (m) => console.log('  [page]', m.text()))
  await page.goto(url)
  await page.bringToFront()
  const box = await page.$eval('#t', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  console.log('text box =', box)

  // Fire the overlay on the active tab (what the toolbar action does). The SW
  // can't read tab URLs without host permissions, so target the active tab.
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_OVERLAY' })
  })
  await page.waitForTimeout(300)

  // Real drag-select around the text.
  await page.mouse.move(box.x - 12, box.y - 12)
  await page.mouse.down()
  await page.mouse.move(box.x + box.w + 12, box.y + box.h + 12, { steps: 8 })
  await page.mouse.up()

  // Poll the side panel, logging status so we see where the chain stops.
  let shown = false
  for (let i = 0; i < 30; i++) {
    await panel.waitForTimeout(1000)
    const st = await panel.evaluate(() => ({
      hidden: document.getElementById('result')?.hidden,
      status: document.getElementById('status')?.textContent,
    }))
    console.log(`  t${i}s status=${JSON.stringify(st.status)} resultHidden=${st.hidden}`)
    if (!st.hidden) {
      shown = true
      break
    }
  }
  if (!shown) throw new Error('side panel never showed a result (see status above)')
  const text = (await panel.$eval('#text', (el) => el.textContent))?.trim() ?? ''
  const backend = await panel.$eval('#backend', (el) => el.textContent)
  console.log('\n=== SIDE PANEL ===')
  console.log('backend =', backend)
  console.log('text    =', JSON.stringify(text))

  const ok = /HELLO\s*OCR\s*7/i.test(text)
  console.log('UX_OK =', ok)
  process.exitCode = ok ? 0 : 1
} catch (e) {
  console.error('UX VERIFY FAILED:', e)
  process.exitCode = 1
} finally {
  await ctx.close()
  server.close()
}
