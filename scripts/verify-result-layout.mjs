// Regression: long results must not shrink and paint over the action buttons.
// Uses synthetic result messages to isolate layout from OCR quality and timing.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const dist = path.resolve('dist')
const profile = mkdtempSync(path.resolve('.pw-layout-'))
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, viewport: { width: 526, height: 910 }, reducedMotion: 'reduce',
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run'],
})
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker')
  await sw.evaluate(() => chrome.storage.local.set({ 'sidepanel.prefs': { history: false } }))
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { value: async (text) => { window.copiedText = text } })
  })
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/src/sidepanel/index.html`)
  const text = Array.from({ length: 70 }, (_, i) => `Line ${i + 1}: example content for a long page capture.`).join('\n') + '\nLAST LINE MUST REMAIN READABLE'
  const table = '| Item | Value |\n| --- | --- |\n' + Array.from({ length: 40 }, (_, i) => `| Item ${i + 1} | ${i + 1} |`).join('\n')
  const latex = '\\begin{aligned}' + Array.from({ length: 25 }, (_, i) => `x_{${i + 1}} &= ${i + 1}`).join('\\\\') + '\\end{aligned}'
  const base = { type: 'OCR_RESULT', mode: 'quick', text, codeText: text, words: [], backend: 'wasm', empty: false,
    imageDataUrl: `data:image/png;base64,${readFileSync('public/test/sample.png').toString('base64')}` }
  const cases = [
    ['code', base, text], ['prose', base, text],
    ['table', { ...base, mode: 'table', docText: table, docBlocks: [{ kind: 'table', markdown: table }] }, table],
    ['formula', { ...base, mode: 'formula', latex, latexOk: true }, latex],
  ]
  for (const size of [{ width: 526, height: 910 }, { width: 320, height: 580 }]) {
    await page.setViewportSize(size)
    for (const [name, result, expected] of cases) {
      await sw.evaluate((r) => chrome.runtime.sendMessage(r), result)
      await page.locator('#state-result').waitFor({ state: 'visible' })
      await page.locator('#crop').evaluate((img) => img.decode())
      if (name === 'code' || name === 'prose') await page.locator(`#seg-${name}`).click()
      if (name === 'formula') assert(await page.locator('.doc-eq-render').isVisible())
      await page.locator('#state-result').evaluate((el) => { el.scrollTop = 100 })
      const geometry = await page.locator('#text').evaluate((el) => {
        const range = document.createRange(); range.selectNodeContents(el)
        return { boxHeight: el.clientHeight, contentHeight: el.scrollHeight,
          contentBottom: range.getBoundingClientRect().bottom,
          buttonsTop: document.querySelector('#state-result .actions').getBoundingClientRect().top }
      })
      const screenshot = path.join(profile, `${name}-${size.width}.png`)
      await page.screenshot({ path: screenshot })
      assert(geometry.contentHeight <= geometry.boxHeight + 1, `${name} ${size.width}: content overflows result box ${JSON.stringify(geometry)}; ${screenshot}`)
      assert(geometry.contentBottom <= geometry.buttonsTop + 1, `${name}: text overlaps capture/copy buttons`)
      await page.locator('#copy').click() // Also proves controls remain reachable by scrolling.
      assert.equal(await page.evaluate(() => window.copiedText), expected)
      await page.locator('#copy').scrollIntoViewIfNeeded()
      assert(await page.locator('#copy').evaluate((button) =>
        button.getBoundingClientRect().bottom <= document.getElementById('state-result').getBoundingClientRect().bottom + 1,
      ), `${name}: copy button must fit above the fixed footer after scrolling`)
      assert.equal(await page.locator('#history-btn').isVisible(), true)
      if (name === 'code') await page.screenshot({ path: path.join(profile, `code-${size.width}-bottom.png`) })
      console.log(`PASS ${name} ${size.width}x${size.height}: contained text, reachable controls, complete copy`)
    }
  }
  console.log('RESULT LAYOUT: PASS; screenshots:', profile)
} finally {
  await ctx.close()
}
