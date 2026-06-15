// Real-world verification: load the extension against a LIVE webpage (not a
// synthetic high-contrast marker page) and run both capture sources. Asserts the
// viewport reads the (large) article title, and that the full-page capture yields
// substantially MORE text than the viewport and reaches content far down the page.
// Network-dependent — a manual diagnostic, not part of the CI verify suite.
//
//   node scripts/verify-realpage.mjs
//
import { chromium } from 'playwright'
import path from 'node:path'
import { rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'

const TARGET = 'https://en.wikipedia.org/wiki/Optical_character_recognition'

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
const profile = path.resolve('.pw-real')
rmSync(profile, { recursive: true, force: true })

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1280, height: 720 },
  args: [`--disable-extensions-except=${distTest}`, `--load-extension=${distTest}`, '--no-first-run'],
})

let failed = false
const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); failed = true } }

try {
  let sw = ctx.serviceWorkers()[0]
  for (let i = 0; i < 20 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); sw = ctx.serviceWorkers()[0] }
  if (!sw) throw new Error('no service worker')
  const extId = new URL(sw.url()).host

  const panel = await ctx.newPage()
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`)

  const page = await ctx.newPage()
  await page.goto(TARGET, { waitUntil: 'load', timeout: 45000 })
  // Let lazy images / layout settle.
  await new Promise((r) => setTimeout(r, 1500))

  const runAndRead = (msg, timeoutMs = 120000) =>
    panel.evaluate(({ m, timeoutMs }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for OCR_RESULT')), timeoutMs)
        const onMsg = (r) => {
          if (r?.type === 'OCR_RESULT') { clearTimeout(timer); chrome.runtime.onMessage.removeListener(onMsg); resolve(r) }
        }
        chrome.runtime.onMessage.addListener(onMsg)
        chrome.runtime.sendMessage(m)
      }), { m: msg, timeoutMs })

  const pageTabId = await panel.evaluate((u) =>
    chrome.tabs.query({}).then((tabs) => (tabs.find((x) => x.url && x.url.startsWith(u)) || {}).id),
    'https://en.wikipedia.org/')
  if (pageTabId === undefined) throw new Error('could not resolve page tab id')

  const origin = 'https://en.wikipedia.org'

  await page.bringToFront(); await new Promise((r) => setTimeout(r, 500))
  const vp = await runAndRead({ type: 'CAPTURE_VIEWPORT', mode: 'quick', origin })
  console.log('\n=== VIEWPORT TEXT ===\n' + vp.text + '\n')

  await page.bringToFront(); await new Promise((r) => setTimeout(r, 500))
  const fp = await runAndRead({ type: 'CAPTURE_FULLPAGE', tabId: pageTabId, origin })
  console.log('=== FULL-PAGE TEXT (note: ' + (fp.note || 'none') + ') ===\n' + fp.text + '\n')

  const vpText = vp.text.toLowerCase()
  const fpText = fp.text.toLowerCase()

  // Viewport reads the large title region.
  check(/optical|character|recognition|ocr/.test(vpText), 'viewport did not read any title word')
  // Full page yields more text and reaches lower content the viewport never showed.
  console.log(`viewport chars=${vp.text.length}, full-page chars=${fp.text.length}`)
  check(fp.text.length > vp.text.length * 1.5, 'full-page text not substantially larger than viewport')
  check(/optical|character|recognition/.test(fpText), 'full-page missing title words')

  console.log(failed ? '\nREAL PAGE: FAIL' : '\nREAL PAGE: PASS')
} catch (e) {
  console.error('REAL PAGE VERIFY ERROR:', e)
  failed = true
} finally {
  await ctx.close()
  process.exit(failed ? 1 : 0)
}
