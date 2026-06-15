// E2E for Page → Markdown hybrid image OCR: a page with a readable image that has
// text baked in → the .md must include the image AND a clearly-labelled OCR caption.
import { chromium } from 'playwright'
import http from 'node:http'
import path from 'node:path'
import { rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'

// The image is drawn in-page onto a canvas and set as a data: URL (same-origin,
// readable — not tainted), so the extractor can OCR it.
const PAGE = `<!doctype html><html><head><title>Image Doc</title></head><body>
<h1>Heading One</h1>
<p>Some prose before the picture.</p>
<img id="pic" alt="a banner" width="900" height="140" />
<p>Prose after.</p>
<script>
  const c = document.createElement('canvas'); c.width = 900; c.height = 140;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0,0,900,140);
  x.fillStyle = '#000'; x.font = 'bold 48px Arial'; x.fillText('PICTURE TEXT OMEGA', 20, 90);
  document.getElementById('pic').src = c.toDataURL('image/png');
</script>
</body></html>`

const server = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE) })
await new Promise((r) => server.listen(0, r))
const url = `http://localhost:${server.address().port}/`

const dist = path.resolve('dist'); const dt = path.resolve('dist-test')
rmSync(dt, { recursive: true, force: true }); cpSync(dist, dt, { recursive: true })
{ const mf = path.join(dt, 'manifest.json'); const m = JSON.parse(readFileSync(mf, 'utf8')); m.host_permissions = ['<all_urls>']; writeFileSync(mf, JSON.stringify(m, null, 2)) }
const profile = path.resolve('.pw-mdi'); rmSync(profile, { recursive: true, force: true })
const ctx = await chromium.launchPersistentContext(profile, { headless: false, viewport: { width: 1100, height: 700 }, args: [`--disable-extensions-except=${dt}`, `--load-extension=${dt}`, '--no-first-run'] })

let failed = false
const check = (c, m) => { if (!c) { console.error('FAIL:', m); failed = true } }
try {
  let sw = ctx.serviceWorkers()[0]
  for (let i = 0; i < 20 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); sw = ctx.serviceWorkers()[0] }
  const extId = new URL(sw.url()).host
  const panel = await ctx.newPage(); await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`)
  const page = await ctx.newPage(); await page.goto(url); await page.bringToFront(); await new Promise((r) => setTimeout(r, 900))
  const tabId = await panel.evaluate((u) => chrome.tabs.query({}).then((t) => (t.find((x) => x.url && x.url.startsWith(u)) || {}).id), url)
  await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'CONVERT_PAGE_MD', tabId: id, origin: location.origin }), tabId)
  await panel.waitForFunction(() => { const e = document.getElementById('md-pre'); return e && e.textContent && e.textContent.length > 20 }, { timeout: 60000 })
  const md = await panel.evaluate(() => document.getElementById('md-pre').textContent)
  console.log('\n=== MARKDOWN ===\n' + md + '\n================')
  check(/# Heading One/.test(md), 'missing heading')
  check(/Text extracted from image \(OCR\):/i.test(md), 'missing OCR caption label')
  check(/PICTURE TEXT OMEGA/i.test(md), 'missing OCR-d image text')
  console.log(failed ? '\nMD IMAGES: FAIL' : '\nMD IMAGES: PASS')
} catch (e) { console.error('MD IMAGES ERROR:', e); failed = true } finally { await ctx.close(); server.close(); process.exit(failed ? 1 : 0) }
