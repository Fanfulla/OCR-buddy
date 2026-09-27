// Offscreen clipboard and bundled release-note navigation. Update dispatch is
// tested in test-capture-actions.ts; this does not simulate Chrome Web Store delivery.
// The OS clipboard write is intercepted in a test-only copied build.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const work = mkdtempSync(path.resolve('.pw-update-'))
const extension = path.join(work, 'extension')
const profile = path.join(work, 'profile')
cpSync(path.resolve('dist'), extension, { recursive: true })
const manifestPath = path.join(extension, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.permissions.push('clipboardWrite') // Test grant; production clipboard access is optional.
manifest.optional_permissions = manifest.optional_permissions.filter((p) => p !== 'clipboardWrite')
writeFileSync(manifestPath, JSON.stringify(manifest))
const offscreenHtml = path.join(extension, 'src/offscreen/offscreen.html')
writeFileSync(offscreenHtml, readFileSync(offscreenHtml, 'utf8').replace('</head>', '<script src="clipboard-probe.js"></script></head>'))
writeFileSync(path.join(extension, 'src/offscreen/clipboard-probe.js'), `
  let copied = null;
  document.execCommand = (command) => {
    if (command !== 'copy') return false;
    copied = document.querySelector('textarea')?.value ?? null;
    return true;
  };
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type === 'TEST_CLIPBOARD') respond({ copied, fields: document.querySelectorAll('textarea').length });
  });
`)
const launch = () => chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run'],
})
const ctx = await launch()
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker')
  const root = `chrome-extension://${new URL(sw.url()).host}`
  const panel = await ctx.newPage()
  await panel.goto(`${root}/src/sidepanel/index.html`)
  assert(!ctx.pages().some((p) => p.url() === `${root}/updates.html`), 'first installation opened release notes')
  await panel.evaluate(() => chrome.storage.local.set({ 'sidepanel.prefs': { autoCopy: true, history: false } }))
  await panel.reload()
  await panel.waitForFunction(() => document.getElementById('auto-copy').checked)
  // Deliver a fresh result while another page has focus, as during screen capture.
  const other = await ctx.newPage()
  await other.goto('about:blank')
  await other.bringToFront()
  await sw.evaluate(() => chrome.runtime.sendMessage({ type: 'OCR_RESULT', mode: 'quick', text: 'LOCAL AUTO COPY', codeText: 'LOCAL AUTO COPY', words: [], backend: 'wasm', imageDataUrl: '', empty: false }))
  await panel.waitForFunction(() => document.getElementById('clipboard-status').textContent === 'Copied to clipboard.')
  const probe = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'TEST_CLIPBOARD' }))
  assert.deepEqual(probe, { copied: 'LOCAL AUTO COPY', fields: 0 })
  console.log('AUTO COPY: PASS (real offscreen flow, system write intercepted)')

  const opened = ctx.waitForEvent('page')
  await panel.locator('#updates-btn').click()
  const updates = await opened
  await updates.waitForURL(`${root}/updates.html`)
  assert.match(await updates.title(), /OCR Buddy/)
  assert.equal(await updates.locator('.version').first().textContent(), `v${manifest.version}`)
  assert.equal(await panel.evaluate(() => chrome.storage.local.get('sidepanel.prefs').then((s) => s['sidepanel.prefs'].history)), false)
  console.log('RELEASE NOTES: PASS (real local navigation; update-event dispatch covered by unit tests)')
} finally {
  await ctx.close()
}
