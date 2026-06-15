// Convert a page's raw HTML into faithful Markdown. Runs in the side panel (a real
// DOM page with DOMParser) — not in the injected script, which must stay a
// classic, import-free function. Structure (headings/lists/links/tables/code) comes
// from the DOM via Turndown; this is NOT OCR.

import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

// Non-content nodes: drop before conversion so the Markdown is clean. We keep
// nav/header/footer (the user asked for the FULL faithful page), only removing
// things that carry no readable text or would corrupt the output.
const STRIP = 'script, style, noscript, template, link, iframe, object, embed, svg defs'

/** Parse HTML into a DETACHED document and strip non-content nodes. Never touches
 *  the live page (the SW already serialized it to a string). Relative links/images
 *  are resolved against the page URL so the Markdown is portable (AI-friendly). */
function clean(html: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll(STRIP).forEach((el) => el.remove())
  // aria-hidden / hidden elements are presentational (icons, offscreen menus).
  doc.querySelectorAll('[aria-hidden="true"], [hidden]').forEach((el) => el.remove())
  // Resolve relative hrefs/srcs to absolute (skip anchors, javascript:, mailto:, data:).
  const absolutize = (els: NodeListOf<Element>, attr: string) => {
    els.forEach((el) => {
      const v = el.getAttribute(attr)
      if (!v || /^(#|javascript:|mailto:|tel:|data:)/i.test(v)) return
      try {
        el.setAttribute(attr, new URL(v, baseUrl).href)
      } catch {
        /* unparseable URL — leave it as-is */
      }
    })
  }
  absolutize(doc.querySelectorAll('a[href]'), 'href')
  absolutize(doc.querySelectorAll('img[src]'), 'src')
  return doc.body.innerHTML
}

function buildService(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx', // # H1
    codeBlockStyle: 'fenced', // ```
    bulletListMarker: '-',
    emDelimiter: '_',
  })
  td.use(gfm) // tables, strikethrough, task lists, highlighted code fences
  return td
}

/** HTML string → Markdown. `title`/`url` become a small front-matter-free header so
 *  an AI consumer knows the source. */
export function htmlToMarkdown(html: string, title: string, url: string): string {
  const body = buildService().turndown(clean(html, url))
  const header = [title && `# ${title}`, url && `<${url}>`].filter(Boolean).join('\n\n')
  return [header, body].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
