// Verification harness: runs the production engine on bundled test images inside
// the real extension origin (CSP, COOP/COEP, getURL, self-hosted wasm, bundled
// models all exercised). Output goes to #out for Playwright (scripts/verify.mjs).
//
//   sample.png      → faithfulness anchor (whitespace-normalized)
//   sample_code.png → low-res indented code → exercises upscaling + code-view

import { recognizeBuffer } from '../offscreen/engine'

const out = document.getElementById('out') as HTMLPreElement
const log = (s = '') => {
  out.textContent += s + '\n'
}

const fetchBuf = async (p: string) => (await fetch(chrome.runtime.getURL(p))).arrayBuffer()
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const leadingSpaces = (s: string) => s.length - s.trimStart().length

async function main() {
  try {
    log('crossOriginIsolated=' + crossOriginIsolated)
    log('webgpu=' + Boolean((navigator as unknown as { gpu?: unknown }).gpu))

    // --- Anchor: faithful content (regression guard for the canvas+flatten switch)
    const a = await recognizeBuffer(await fetchBuf('test/sample.png'))
    log('\n[anchor sample.png]')
    log('backend=' + a.backend + ' empty=' + a.empty + ' words=' + a.words.length)
    const anchorText = norm(a.text)
    log('text=' + JSON.stringify(anchorText))
    const anchorOk = anchorText === 'OCR Buddy 2026 const x = 42;'
    log('ANCHOR_OK=' + anchorOk)

    // --- Code: upscaling + indentation reconstruction
    const c = await recognizeBuffer(await fetchBuf('test/sample_code.png'))
    log('\n[code sample_code.png]')
    log('backend=' + c.backend + ' empty=' + c.empty)
    log('lines=' + JSON.stringify(c.lines.map((l) => l.map((w) => ({ t: w.text, x: Math.round(w.box.x), w: Math.round(w.box.width) })))))
    log('--- codeText ---')
    log(c.codeText)
    log('--- /codeText ---')

    const indents = c.codeText.split('\n').map(leadingSpaces)
    log('indents=' + JSON.stringify(indents))
    // Source indents were 0,4,4,8,4. Assert the recovered nesting structure:
    // line0 flush; lines 1/2/4 one level; line3 twice that level.
    const codeOk =
      indents.length >= 5 &&
      indents[0] === 0 &&
      indents[1] > 0 &&
      indents[1] === indents[2] &&
      indents[1] === indents[4] &&
      indents[3] === 2 * indents[1]
    log('CODE_INDENT_OK=' + codeOk)

    // --- Emoji: a low-res code frame with inline emoji. An undetected emoji splits
    // a line into two boxes with a wide gap; the column-aware reading order must NOT
    // read the trailing fragment as a separate column (which floated it to the end).
    const e = await recognizeBuffer(await fetchBuf('test/sample_emoji.png'))
    log('\n[emoji sample_emoji.png]')
    log('--- codeText ---')
    log(e.codeText)
    log('--- /codeText ---')
    const elines = e.codeText.split('\n')
    const sprinklesLine = elines.find((l) => l.includes('You add sprinkles')) ?? ''
    // The "*\"" fragment after the emoji must rejoin its own line, not float alone.
    const emojiOk = sprinklesLine.includes('*"') && !elines.some((l) => l.trim() === '*"')
    log('EMOJI_LINE_OK=' + emojiOk)
    // The emoji itself is marked with the unread-glyph placeholder on its own line.
    // Both emoji are marked: the mid-line 🐝 on the sprinkles line, and the trailing
    // 🍧 at the end of the "ice cream" line.
    const creamLine = elines.find((l) => l.includes('your ice cream')) ?? ''
    const emojiMarkOk = sprinklesLine.includes('□') && creamLine.includes('□')
    log('EMOJI_MARK_OK=' + emojiMarkOk)

    document.body.dataset.done = anchorOk && codeOk && emojiOk && emojiMarkOk ? 'ok' : 'partial'
  } catch (e) {
    log('ERROR: ' + (e instanceof Error ? (e.stack ?? e.message) : String(e)))
    document.body.dataset.done = 'err'
  }
}

void main()
