# OCR Buddy 2.6 validation

## Design and compatibility

- Chrome-native commands reuse the existing capture paths. New viewport/full-page
  commands start unbound to avoid taking existing shortcuts; users assign them in Chrome.
- Existing icon behavior and history preferences remain unchanged. Automatic copy
  defaults to off and requests optional clipboard write access on activation.
- The website and extension share `site/changelog.html`. The build copies it into
  `dist/updates.html`, which is not declared web-accessible. It has no analytics,
  remote fonts or scripts. Only version-changing extension updates open it automatically.
- PDF.js 5.5.207 is pinned and uses its legacy build, with bundled worker, fonts,
  character maps, codecs and license files. Its upstream legacy build targets
  Chrome 118+, but Chrome 124 itself has not been exercised in this validation.
- PDF imports accept local bytes only. Existing text is extracted; image-only
  pages use local OCR. Mixed pages require force OCR to read image text too.
  Limits are 50,000,000 bytes and 300 pages. Results are never added to history.
- `onnxruntime-web` stays at the tested lockfile version 1.26.0 and PP-OCRv5 stays
  unchanged. This release does not claim an accuracy improvement from a new model.
- Dependency audit fixes update PostCSS, nanoid, protobufjs and the Node-only
  runtime/tooling chain within existing ranges. No Vite/TypeScript major migration.

## Primary references reviewed

- [Chrome Commands](https://developer.chrome.com/docs/extensions/reference/api/commands):
  supported shortcuts, collision handling and user configuration.
- [Side Panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel):
  opening from a user gesture, before asynchronous preference reads.
- [Tabs captureVisibleTab](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab):
  capture is window-based; target checks cannot make it atomically tab-bound.
- [Optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions):
  request clipboard access only when the feature is enabled.
- [Chrome offscreen clipboard example](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.offscreen-clipboard-write):
  writing multiline text without depending on panel focus.
- [PDF.js examples](https://mozilla.github.io/pdf.js/examples/) and
  [5.5.207 build targets](https://github.com/mozilla/pdf.js/blob/v5.5.207/gulpfile.mjs):
  local document loading, page rendering and legacy compatibility.

## Verification

- TypeScript and production build.
- Existing merge, restricted-page and review tests.
- Capture tests: tab identity, navigation, quota retry, scroll restoration,
  command admission, selection cancellation, clipboard boundaries and update routing.
- Browser integration: OCR testbed, region capture, viewport/full-page markers,
  DOM Markdown and hybrid image OCR.
- Panel integration: narrow layouts, preference restoration, history selection/order,
  clipboard denial/error feedback and manual release-note navigation.
- PDF integration: synthetic native-text and scanned pages, actual local OCR,
  forced OCR, page range, invalid range and cancellation. HTTP requests blocked.
- Clipboard integration: actual offscreen request path while the panel lacks focus;
  the final system write is intercepted so tests do not change developer clipboard data.
- Release-note desktop/mobile rendering and links, with HTTP requests blocked.
- Node CPU model-loading smoke test after the Node-only runtime update.
- `npm audit`: zero reported vulnerabilities after the lockfile updates.

## Remaining release checks

- Test toolbar clicks and assigned keyboard shortcuts on a normal installed Chrome
  profile, including macOS and the minimum supported Chrome version. Entry-point
  dispatch is covered by mocks; browser OCR flows are covered by integration tests.
- Confirm update behavior through Chrome Web Store delivery. The unpacked browser
  harness does not reproduce that delivery lifecycle; update-event routing is unit-tested.
- Embedded PDFs must currently be saved and imported. Arbitrary viewer access,
  nested scroll containers and complex layout reconstruction are not implemented.
- PDF password workflows, uncommon codecs/fonts and very large documents need a
  broader real-document corpus before expanding support claims.

No website deployment, store upload or remote push is implied by local validation.
