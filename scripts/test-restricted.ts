import assert from 'node:assert/strict'
import { restrictedReason } from '../src/shared/restricted.ts'

// Chrome Web Store (new host) — any path, incl. the discover page from the bug report.
assert.equal(restrictedReason('https://chromewebstore.google.com/?hl=it'), 'the Chrome Web Store')
assert.equal(restrictedReason('https://chromewebstore.google.com/detail/abc/efg'), 'the Chrome Web Store')

// Chrome Web Store (legacy host) — only under /webstore, not the rest of chrome.google.com.
assert.equal(restrictedReason('https://chrome.google.com/webstore/category/extensions'), 'the Chrome Web Store')
assert.equal(restrictedReason('https://chrome.google.com/maps'), null)

// Privileged browser / extension pages — no host grant can ever unblock these.
assert.equal(restrictedReason('chrome://extensions'), 'browser and extension pages')
assert.equal(restrictedReason('chrome://newtab/'), 'browser and extension pages')
assert.equal(restrictedReason('edge://settings'), 'browser and extension pages')
assert.equal(restrictedReason('about:blank'), 'browser and extension pages')
assert.equal(restrictedReason('view-source:https://example.com'), 'browser and extension pages')
assert.equal(restrictedReason('chrome-extension://abcdef/page.html'), 'browser and extension pages')
assert.equal(restrictedReason('devtools://devtools/bundled/inspector.html'), 'browser and extension pages')

// Normal capturable pages → not restricted.
assert.equal(restrictedReason('https://example.com/article'), null)
assert.equal(restrictedReason('http://localhost:3000'), null)
// file:// is gated by Chrome's "Allow access to file URLs" toggle, not a host grant
// — leave it to the existing permission flow, don't dead-end it here.
assert.equal(restrictedReason('file:///C:/doc.pdf'), null)

// Missing / unparseable input → never block (fail open).
assert.equal(restrictedReason(undefined), null)
assert.equal(restrictedReason(''), null)
assert.equal(restrictedReason('not a url'), null)

console.log('restrictedReason: all assertions passed')
