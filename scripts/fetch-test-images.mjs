// Populate test-images/ (gitignored) with REAL rendered pages from reliable
// sources — Wikipedia (every language pack's script), docs.python.org (code),
// Wikipedia math articles (LaTeX) — plus the ground truth extracted from the
// same DOM node that was screenshotted.
//
//   node scripts/fetch-test-images.mjs
//
// Output, per case:
//   test-images/<lang>__<name>.png        the screenshot (deviceScaleFactor 2)
//   test-images/<lang>__<name>.txt        ground truth (innerText of the node)
//   test-images/latex__<name>.latex.txt   LaTeX source (img alt) — .latex.txt on
//                                         purpose so the CER scorer ignores it
//
// The <lang>__ prefix tells scripts/ocr-image-test.mjs which language pack to
// score with. Country/flagship articles are used because they're maximally
// stable; still, selectors can drift — each case fails independently.

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DIR = resolve('test-images')
mkdirSync(DIR, { recursive: true })

// A Wikipedia case: screenshot the first long-enough body paragraph. Some
// wikis nest paragraphs inside section/div wrappers, so use a descendant
// selector and walk candidates with a short per-element timeout.
const wiki = (lang, name, url, minLen = 150) => ({
  name: `${lang}__${name}`,
  url,
  async pick(page) {
    const all = page.locator('#mw-content-text p')
    const n = Math.min(await all.count(), 25)
    for (let i = 0; i < n; i++) {
      const cand = all.nth(i)
      try {
        const text = (await cand.innerText({ timeout: 2000 })).trim()
        if (text.length >= minLen && (await cand.boundingBox())) return { el: cand, gt: text }
      } catch {
        // hidden/detached candidate — try the next one
      }
    }
    throw new Error(`no paragraph ≥ ${minLen} chars among first ${n}`)
  },
})

const cases = [
  // ── Latin (bundled pack) ────────────────────────────────────────────────
  wiki('latin', 'wiki_en_ocr', 'https://en.wikipedia.org/wiki/Optical_character_recognition'),
  wiki('latin', 'wiki_it_italia', 'https://it.wikipedia.org/wiki/Italia'),
  wiki('latin', 'wiki_fr_france', 'https://fr.wikipedia.org/wiki/France'),
  wiki('latin', 'wiki_de_deutschland', 'https://de.wikipedia.org/wiki/Deutschland'),
  wiki('latin', 'wiki_es_espana', 'https://es.wikipedia.org/wiki/España'),
  // Code: stable static docs page, real syntax-styled <pre> block.
  {
    name: 'latin__code_python',
    url: 'https://docs.python.org/3/tutorial/introduction.html',
    async pick(page) {
      const pres = page.locator('pre')
      const n = await pres.count()
      for (let i = 0; i < n; i++) {
        const cand = pres.nth(i)
        const text = (await cand.innerText()).trim()
        if (text.length >= 150) return { el: cand, gt: text }
      }
      throw new Error('no long <pre> found')
    },
  },
  // ── Non-Latin packs ─────────────────────────────────────────────────────
  wiki('eslav', 'wiki_ru_rossiya', 'https://ru.wikipedia.org/wiki/Россия'),
  wiki('cyrillic', 'wiki_sr_srbija', 'https://sr.wikipedia.org/wiki/Србија'),
  wiki('el', 'wiki_el_ellada', 'https://el.wikipedia.org/wiki/Ελλάδα'),
  wiki('zh', 'wiki_zh_china', 'https://zh.wikipedia.org/wiki/中国', 80),
  wiki('zh', 'wiki_ja_nihon', 'https://ja.wikipedia.org/wiki/日本', 80), // ja is in the zh pack
  wiki('korean', 'wiki_ko_korea', 'https://ko.wikipedia.org/wiki/대한민국', 80),
  wiki('th', 'wiki_th_thailand', 'https://th.wikipedia.org/wiki/ประเทศไทย', 80),
  wiki('devanagari', 'wiki_hi_bharat', 'https://hi.wikipedia.org/wiki/भारत', 100),
  wiki('ta', 'wiki_ta_indhiya', 'https://ta.wikipedia.org/wiki/இந்தியா', 100),
  wiki('te', 'wiki_te_bharata', 'https://te.wikipedia.org/wiki/భారతదేశం', 100),
  // ── LaTeX (Formula mode material; GT = the alt text = LaTeX source) ─────
  {
    name: 'latex__quadratic',
    url: 'https://en.wikipedia.org/wiki/Quadratic_formula',
    async pick(page) {
      const el = page.locator('.mwe-math-element').first()
      const gt = (await el.locator('img').first().getAttribute('alt')) ?? ''
      return { el, gt, gtExt: '.latex.txt' }
    },
  },
  {
    name: 'latex__euler_identity',
    url: 'https://en.wikipedia.org/wiki/Euler%27s_identity',
    async pick(page) {
      const el = page.locator('.mwe-math-element').first()
      const gt = (await el.locator('img').first().getAttribute('alt')) ?? ''
      return { el, gt, gtExt: '.latex.txt' }
    },
  },
]

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 1000 },
  deviceScaleFactor: 2, // crisp glyphs — matches a HiDPI capture
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
})
const page = await ctx.newPage()

let ok = 0
let fail = 0
for (const c of cases) {
  try {
    await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    // Let images/fonts settle: late layout shifts move the element between
    // measurement and capture, producing a crop of the wrong region.
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    const { el, gt, gtExt = '.txt' } = await c.pick(page)
    // element.screenshot handles scrolling itself — a manual page.screenshot
    // clip from boundingBox() mixes viewport and document coordinates and
    // captures the wrong region once the page has scrolled.
    await el.screenshot({ path: join(DIR, `${c.name}.png`) })
    writeFileSync(join(DIR, `${c.name}${gtExt}`), gt, 'utf8')
    console.log(`ok   ${c.name}  (gt ${gt.length} chars)`)
    ok++
  } catch (e) {
    console.log(`FAIL ${c.name}: ${e instanceof Error ? e.message.split('\n')[0] : e}`)
    fail++
  }
}

await browser.close()
console.log(`\n${ok} fetched, ${fail} failed → ${DIR}`)
process.exitCode = fail && !ok ? 1 : 0
