// E2E for Page → Markdown: load a known HTML page, trigger CONVERT_PAGE_MD, and
// assert the panel produced faithful Markdown (heading, list, link, fenced code,
// table). Mirrors verify-ux.mjs setup.
import { chromium } from 'playwright'
import http from 'node:http'
import path from 'node:path'
import { rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'

const PAGE = `<!doctype html><html><head><title>Sample Doc</title></head><body>
<h1>Main Heading</h1>
<p>A paragraph with a <a href="https://example.com/x">link here</a> inside.</p>
<h2>A list</h2>
<ul><li>first item</li><li>second item</li></ul>
<pre><code>const x = 41 + 1
console.log(x)</code></pre>
<table>
  <thead><tr><th>Name</th><th>Age</th></tr></thead>
  <tbody><tr><td>Bob</td><td>30</td></tr><tr><td>Alice</td><td>27</td></tr></tbody>
</table>
<script>console.log('should be stripped')</script>
</body></html>`

const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) })
await new Promise((r) => server.listen(0, r))
const url = `http://localhost:${server.address().port}/`

const dist = path.resolve('dist'); const distTest = path.resolve('dist-test')
rmSync(distTest, { recursive: true, force: true }); cpSync(dist, distTest, { recursive: true })
{ const mf = path.join(distTest, 'manifest.json'); const m = JSON.parse(readFileSync(mf, 'utf8')); m.host_permissions = ['<all_urls>']; writeFileSync(mf, JSON.stringify(m, null, 2)) }
const profile = path.resolve('.pw-md'); rmSync(profile, { recursive: true, force: true })
const ctx = await chromium.launchPersistentContext(profile, { headless: false, viewport: { width: 1280, height: 720 }, args: [`--disable-extensions-except=${distTest}`, `--load-extension=${distTest}`, '--no-first-run'] })

let failed = false
const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); failed = true } }

try {
  let sw = ctx.serviceWorkers()[0]
  for (let i = 0; i < 20 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); sw = ctx.serviceWorkers()[0] }
  if (!sw) throw new Error('no service worker')
  const extId = new URL(sw.url()).host

  const panel = await ctx.newPage()
  panel.on('console', (m) => console.log('  [panel]', m.text()))
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`)

  const page = await ctx.newPage()
  await page.goto(url)
  await page.bringToFront(); await new Promise((r) => setTimeout(r, 400))

  const pageTabId = await panel.evaluate((u) =>
    chrome.tabs.query({}).then((tabs) => (tabs.find((x) => x.url && x.url.startsWith(u)) || {}).id), url)
  if (pageTabId === undefined) throw new Error('could not resolve page tab id')

  await panel.evaluate(({ tabId, origin }) => chrome.runtime.sendMessage({ type: 'CONVERT_PAGE_MD', tabId, origin }),
    { tabId: pageTabId, origin: url.replace(/\/$/, '') })

  // Wait for the panel to render the markdown.
  await panel.waitForFunction(() => {
    const el = document.getElementById('md-pre')
    return el && el.textContent && el.textContent.length > 20
  }, { timeout: 20000 })
  const md = await panel.evaluate(() => document.getElementById('md-pre').textContent)
  console.log('\n=== MARKDOWN ===\n' + md + '\n================')

  check(/^# .*Sample Doc/m.test(md) || /# Sample Doc/.test(md), 'missing title H1')
  check(/^# Main Heading/m.test(md) || /# Main Heading/.test(md), 'missing Main Heading')
  check(/## A list/.test(md), 'missing H2 "A list"')
  check(/-\s+first item/.test(md) && /-\s+second item/.test(md), 'missing bullet list')
  check(/\[link here\]\(https:\/\/example\.com\/x\)/.test(md), 'missing markdown link')
  check(/```[\s\S]*const x = 41 \+ 1[\s\S]*```/.test(md), 'missing fenced code block')
  check(/\| ?Name ?\| ?Age ?\|/.test(md) && /\| ?Bob ?\| ?30 ?\|/.test(md), 'missing GFM table')
  check(!/should be stripped/.test(md), 'script content was NOT stripped')

  console.log(failed ? '\nPAGE→MD: FAIL' : '\nPAGE→MD: PASS')
} catch (e) { console.error('PAGE→MD VERIFY ERROR:', e); failed = true } finally { await ctx.close(); server.close(); process.exit(failed ? 1 : 0) }
