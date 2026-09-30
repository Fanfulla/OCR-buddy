// Pages where a browser categorically forbids extensions from injecting scripts
// or taking screenshots — the browser's add-on store and privileged pages
// pages. This block is independent of host permissions: `chrome.permissions.request`
// may report the origin as granted, yet `scripting.executeScript` and
// `captureVisibleTab` still throw. So capture must abstain with an honest message
// here instead of looping on the "Enable for this site" prompt.

/** If `url` is a page the browser won't let us capture, return a human phrase naming the
 *  page class (e.g. "the Chrome Web Store"); otherwise null. Fails open on missing
 *  or unparseable input — never block a page we can't classify. */
export function restrictedReason(url: string | undefined | null): string | null {
  if (!url) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (
    u.hostname === 'chromewebstore.google.com' ||
    (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'))
  ) {
    return 'the Chrome Web Store'
  }
  if (u.hostname === 'addons.mozilla.org' || u.hostname === 'addons.allizom.org') {
    return 'the Firefox Add-ons site'
  }
  // chrome:, edge:, about:, view-source:, moz-extension:, devtools: … — any
  // scheme that isn't a normal web page. file: is excluded: it's gated by the browser's
  // separate "Allow access to file URLs" toggle, so the permission flow handles it.
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') {
    return 'browser and extension pages'
  }
  return null
}
