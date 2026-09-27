// Browser integration checks on the production bundle. Clipboard writes are
// intercepted so this test never overwrites the developer's system clipboard.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const dist = path.resolve('dist')
const profile = mkdtempSync(path.resolve('.pw-actions-'))
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 360, height: 760 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run'],
})
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker')
  const root = `chrome-extension://${new URL(sw.url()).host}`
  const base = { type: 'OCR_RESULT', mode: 'quick', text: 'First capture', codeText: 'first()', words: [], backend: 'wasm', imageDataUrl: '', empty: false }
  await sw.evaluate(({ base }) => chrome.storage.local.set({
    'sidepanel.prefs': { captureMode: 'quick', codeMode: false, lang: 'latin', history: false },
    'history.v1': [
      { ts: 3000, result: { ...base, mode: 'formula', latex: 'x^2', latexOk: true } },
      { ts: 2000, result: { ...base, mode: 'table', docText: '| A | B |\n| --- | --- |\n| 1 | 2 |' } },
      { ts: 1000, result: base },
    ],
  }), { base })
  const panel = await ctx.newPage()
  const errors = []
  panel.on('pageerror', (e) => errors.push(e.message))
  await panel.addInitScript(() => {
    window.__writes = []
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, writable: true, value: async (text) => window.__writes.push(text) })
  })
  await panel.goto(`${root}/src/sidepanel/index.html`)
  await panel.waitForFunction(() => document.getElementById('shortcut-list').textContent.includes('capture'))
  assert.equal(await panel.locator('#auto-copy').isChecked(), false)
  const commands = await sw.evaluate(() => chrome.commands.getAll())
  for (const name of ['start-capture', 'capture-viewport', 'capture-fullpage']) assert(commands.some((c) => c.name === name))
  const toolbar = await panel.locator('.capture-toolbar').boundingBox()
  assert(toolbar && toolbar.y < 100, 'capture toolbar should be at the top')
  assert(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'panel overflows horizontally')
  await panel.screenshot({ path: path.join(profile, 'idle.png'), fullPage: true })
  await panel.setViewportSize({ width: 320, height: 760 })
  assert(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow panel overflows horizontally')
  await panel.setViewportSize({ width: 360, height: 760 })

  await panel.locator('#history-btn').click()
  assert.equal(await panel.locator('.hist-select').count(), 3)
  assert.equal(await panel.locator('#hist-enabled').isChecked(), false, 'old history preference must survive')
  assert.equal(await panel.locator('#hist-copy').isEnabled(), false)
  await panel.locator('.hist-select').nth(0).check()
  await panel.locator('.hist-select').nth(2).check()
  assert.equal(await panel.locator('#hist-select-all').evaluate((el) => el.indeterminate), true)
  await panel.locator('#hist-copy').click()
  assert.equal(await panel.evaluate(() => window.__writes.at(-1)), 'First capture\n\n---\n\nx^2')
  await panel.locator('#hist-select-all').check()
  await panel.locator('#hist-copy').click()
  assert.equal(await panel.evaluate(() => window.__writes.at(-1)), 'First capture\n\n---\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n---\n\nx^2')
  await panel.locator('#hist-select-all').uncheck()
  assert.equal(await panel.locator('#hist-export').isEnabled(), false)
  const writesBeforeRestore = await panel.evaluate(() => window.__writes.length)
  await panel.locator('.hist-open').nth(2).click()
  assert.equal(await panel.locator('.capture-toolbar').isVisible(), true)
  assert.equal(await panel.evaluate(() => window.__writes.length), writesBeforeRestore, 'history navigation must not copy')
  await panel.locator('#text').fill('Edited line one\nEdited line two')
  await panel.locator('#copy').click()
  assert.equal(await panel.evaluate(() => window.__writes.at(-1)), 'Edited line one\nEdited line two')

  await panel.locator('#quick-settings summary').click()
  await panel.locator('#icon-action').selectOption('select')
  await panel.waitForFunction(() => chrome.storage.local.get('sidepanel.prefs').then((s) => s['sidepanel.prefs'].iconAction === 'select'))
  await panel.reload()
  await panel.waitForFunction(() => document.getElementById('icon-action').value === 'select')
  assert.equal(await panel.locator('#auto-copy').isChecked(), false)
  await panel.locator('#quick-settings summary').click()
  // Denied permission: do not save an enabled switch or claim success.
  await panel.evaluate(() => { chrome.permissions.request = async () => false })
  await panel.locator('#auto-copy').click()
  await panel.waitForFunction(() => !document.getElementById('auto-copy').disabled)
  assert.equal(await panel.locator('#auto-copy').isChecked(), false)
  assert.equal(await panel.evaluate(() => chrome.storage.local.get('sidepanel.prefs').then((s) => s['sidepanel.prefs'].autoCopy)), false)

  // Native write rejection must not show a false "Copied" indication.
  await sw.evaluate((r) => chrome.runtime.sendMessage(r), base)
  await panel.locator('#state-result').waitFor({ state: 'visible' })
  await panel.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('blocked') } })
  await panel.locator('#copy').click()
  await panel.waitForFunction(() => document.getElementById('clipboard-status').textContent.includes('Could not copy'))
  assert.match(await panel.locator('#clipboard-status').textContent(), /Could not copy/)
  // A source may disappear before the worker can announce "selecting".
  await panel.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (msg, ...args) => msg.type === 'START_SELECTION' ? Promise.resolve() : send(msg, ...args)
  })
  await panel.locator('#select-btn').click()
  await panel.locator('#state-busy').waitFor({ state: 'visible' })
  await sw.evaluate(() => chrome.runtime.sendMessage({ type: 'SELECTION_CANCELLED' }))
  await panel.locator('#state-result').waitFor({ state: 'visible' })
  assert.equal(await panel.locator('#select-btn').isEnabled(), true)
  assert.deepEqual(errors, [])
  await panel.screenshot({ path: path.join(profile, 'panel.png'), fullPage: true })
  console.log('PANEL ACTIONS: PASS (browser UI; clipboard writes mocked)')
  console.log('Screenshot:', path.join(profile, 'panel.png'))
  console.log('Idle screenshot:', path.join(profile, 'idle.png'))
  const updates = await ctx.newPage()
  const requests = []
  await updates.route(/^https?:/, (route) => { requests.push(route.request().url()); return route.abort() })
  await updates.setViewportSize({ width: 1120, height: 900 })
  await updates.goto(`${root}/updates.html`)
  assert.equal(await updates.locator('#added').textContent(), 'Added')
  assert.equal(await updates.locator('#changed').textContent(), 'Changed')
  assert.equal(await updates.locator('#removed').textContent(), 'Removed')
  assert.equal(await updates.locator('a[href="https://x.com/Fanfulladev"]').count(), 2)
  await updates.screenshot({ path: path.join(profile, 'changelog.png'), fullPage: true })
  await updates.setViewportSize({ width: 360, height: 760 })
  assert(await updates.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile changelog overflows')
  assert.deepEqual(requests, [], 'changelog attempted an HTTP request')
  console.log('CHANGELOG: PASS (desktop/mobile, links, no HTTP requests)')
  console.log('Changelog screenshot:', path.join(profile, 'changelog.png'))
} finally {
  await ctx.close()
}
