// End-to-end verification for CAPTURE_VIEWPORT and CAPTURE_FULLPAGE capture sources.
// Serves a tall test page with markers at the top and bottom (only reachable after
// scrolling), fires both capture messages from the panel context while keeping the
// page tab as the foreground tab, and asserts both markers appear in the full-page
// result while only the top marker appears in the viewport result.
//
//   node scripts/verify-capture-sources.mjs
//
import { chromium } from 'playwright'
import http from 'node:http'
import path from 'node:path'
import { rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'

const PAGE = `<!doctype html><html><body style="margin:0;padding:40px;background:#fff;font-family:Arial;box-sizing:border-box">
<h1 style="font-size:54px;margin:0 0 20px;color:#000">TOP MARKER ALPHA</h1>
<div style="height:1500px"></div>
<h1 style="font-size:54px;margin:0;color:#000">BOTTOM MARKER OMEGA</h1>
<div style="height:200px"></div>
</body></html>`

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(PAGE)
})
await new Promise((r) => server.listen(0, r))
const port = server.address().port
const url = `http://localhost:${port}/`

// Test build: a copy of dist with host_permissions added, so captureVisibleTab
// works WITHOUT the activeTab grant that only a real toolbar click provides.
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

const profile = path.resolve('.pw-cap')
rmSync(profile, { recursive: true, force: true })

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1280, height: 720 },
  args: [`--disable-extensions-except=${distTest}`, `--load-extension=${distTest}`, '--no-first-run'],
})

let failed = false
const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); failed = true } }

try {
  // Wait for the service worker to start.
  let sw = ctx.serviceWorkers()[0]
  for (let i = 0; i < 20 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    sw = ctx.serviceWorkers()[0]
  }
  if (!sw) throw new Error('no service worker')
  const extId = new URL(sw.url()).host
  console.log('extensionId =', extId)

  // Open the side panel as a normal tab — it listens for OCR_RESULT and relays it.
  const panel = await ctx.newPage()
  panel.on('console', (m) => console.log('  [panel]', m.text()))
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`)

  // Open the page under test.
  const page = await ctx.newPage()
  page.on('console', (m) => console.log('  [page]', m.text()))
  await page.goto(url)

  // Register a helper that, from within the panel's extension context:
  //   1. Adds an onMessage listener for OCR_RESULT.
  //   2. Sends the capture message.
  //   3. Resolves with the OCR text (or rejects on timeout).
  // We run this via panel.evaluate so the page tab STAYS foreground — evaluate
  // runs JS in the panel context without focusing the panel window/tab.
  const runAndRead = (msg, timeoutMs = 60000) =>
    panel.evaluate(({ m, timeoutMs }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for OCR_RESULT')), timeoutMs)
        const onMsg = (r) => {
          if (r?.type === 'OCR_RESULT') {
            clearTimeout(timer)
            chrome.runtime.onMessage.removeListener(onMsg)
            resolve(r.text)
          } else if (r?.type === 'OCR_STATUS') {
            console.log('[status]', JSON.stringify(r))
          }
        }
        chrome.runtime.onMessage.addListener(onMsg)
        chrome.runtime.sendMessage(m)
      }), { m: msg, timeoutMs })

  // Resolve the tabId of the page-under-test from the panel's extension context.
  const pageTabId = await panel.evaluate((u) =>
    chrome.tabs.query({}).then((tabs) => {
      const t = tabs.find((x) => x.url && x.url.startsWith(u))
      return t ? t.id : undefined
    }), url)
  if (pageTabId === undefined) throw new Error('could not resolve page tab id')
  console.log('pageTabId =', pageTabId)

  const originArg = url.replace(/\/$/, '')

  // --- VIEWPORT CAPTURE ---
  // The page must be the foreground tab when captureVisibleTab fires.
  // bringToFront focuses it; we keep it there for the whole capture.
  await page.bringToFront()
  await new Promise((r) => setTimeout(r, 400))
  console.log('sending CAPTURE_VIEWPORT…')
  const vp = await runAndRead({ type: 'CAPTURE_VIEWPORT', mode: 'quick', origin: originArg })
  console.log('viewport:', JSON.stringify(vp))

  // --- FULL-PAGE CAPTURE ---
  // Same rule: page must be foreground. captureFullPage scrolls and calls
  // captureVisibleTab(windowId) for each tile — foreground throughout.
  await page.bringToFront()
  await new Promise((r) => setTimeout(r, 400))
  console.log('sending CAPTURE_FULLPAGE…')
  const fp = await runAndRead({ type: 'CAPTURE_FULLPAGE', tabId: pageTabId, origin: originArg })
  console.log('fullpage:', JSON.stringify(fp))

  // --- ASSERTIONS ---
  check(/TOP MARKER ALPHA/i.test(vp), 'viewport missing TOP MARKER ALPHA')
  check(!/BOTTOM MARKER OMEGA/i.test(vp), 'viewport unexpectedly contains BOTTOM MARKER OMEGA (page scrolled?)')
  check(/TOP MARKER ALPHA/i.test(fp), 'full-page missing TOP MARKER ALPHA')
  check(/BOTTOM MARKER OMEGA/i.test(fp), 'full-page missing BOTTOM MARKER OMEGA')
  check((fp.match(/TOP MARKER ALPHA/gi) || []).length === 1, 'TOP MARKER ALPHA duplicated across seam')

  console.log(failed ? 'CAPTURE SOURCES: FAIL' : 'CAPTURE SOURCES: PASS')
} catch (e) {
  console.error('CAPTURE SOURCES VERIFY FAILED:', e)
  failed = true
} finally {
  await ctx.close()
  server.close()
  process.exit(failed ? 1 : 0)
}
