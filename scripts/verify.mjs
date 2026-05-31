// Automated runtime verification: load the built extension in real Chrome, open
// the testbed page (which runs the production engine on a bundled test image),
// and print its output. Proves ORT + ppu-paddle-ocr + bundled models + self-hosted
// wasm actually run inside the MV3 extension origin.
//
//   node scripts/verify.mjs
//
import { chromium } from 'playwright'
import path from 'node:path'
import { rmSync } from 'node:fs'

const dist = path.resolve('dist')
const profile = path.resolve('.pw-profile')
rmSync(profile, { recursive: true, force: true })

// Use Playwright's bundled Chromium (not channel:'chrome') — the system Chrome is
// org-managed and policy blocks --load-extension. Must run HEADED: Playwright only
// loads extensions reliably with a headed persistent context.
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run'],
})

try {
  // Poll for the MV3 service worker (it may register lazily).
  let sw = ctx.serviceWorkers()[0]
  for (let i = 0; i < 20 && !sw; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    sw = ctx.serviceWorkers()[0]
    if (i % 3 === 0) console.log(`  waiting for SW… ${i}s (workers=${ctx.serviceWorkers().length})`)
  }
  if (!sw) throw new Error('no service worker — extension did not load')
  const extId = new URL(sw.url()).host
  console.log('extensionId =', extId)

  const page = await ctx.newPage()
  page.on('console', (m) => console.log('  [console]', m.type(), m.text()))
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))

  await page.goto(`chrome-extension://${extId}/src/testbed/testbed.html`)
  await page.waitForFunction(() => document.body.dataset.done, { timeout: 180000 })

  const status = await page.evaluate(() => document.body.dataset.done)
  const out = await page.$eval('#out', (el) => el.textContent)
  console.log('\n=== TESTBED OUTPUT (status=' + status + ') ===')
  console.log(out)
  process.exitCode = status === 'ok' ? 0 : 1
} catch (e) {
  console.error('VERIFY FAILED:', e)
  process.exitCode = 1
} finally {
  await ctx.close()
}
