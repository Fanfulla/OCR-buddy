# Firefox Build and Compatibility

The Firefox build is a Manifest V3 WebExtension for desktop Firefox 142 or newer.
It reuses the PP-OCRv5 models, ONNX Runtime Web, preprocessing, formula recognizer,
and result UI from the Chrome extension.

## Build

```powershell
npm ci
npm run build:firefox
```

The loadable extension is written to `dist-firefox/`. `npm run build` and
`npm run build:chrome` continue to build the existing Chrome extension in `dist/`.

## Temporary Installation

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Select **Load Temporary Add-on…**.
3. Choose `dist-firefox/manifest.json`.
4. Open a regular webpage, click the OCR Buddy toolbar button, then select an area
   in the sidebar and copy the result.

Firefox removes temporary add-ons when it exits. After rebuilding, use **Reload**
on the add-on's `about:debugging` row to load the new files.

## API Mapping

| Chromium API or behavior | Firefox implementation |
| --- | --- |
| `chrome.sidePanel.open()` and `side_panel` manifest entry | `browser.sidebarAction.open()` and `sidebar_action`; Firefox opens the sidebar for the active window rather than a selected tab. |
| `chrome.offscreen.createDocument()`, `runtime.getContexts()`, and `offscreen` permission | A hidden iframe loads the existing OCR host page inside the sidebar. A ping confirms that its listener is ready before OCR begins. |
| MV3 service worker | Firefox uses a module background event page (`background.scripts`). It coordinates capture; inference stays in the sidebar iframe. |
| Runtime URL for shortcut settings | `about:addons`; use Firefox's extension-shortcut controls there. |
| `scripting.executeScript` document targeting | The implementation uses `documentId` when returned and falls back to the top-frame ID on Firefox versions that do not return it. |
| `chrome.*` APIs with standard WebExtension equivalents | The compatibility adapter uses `browser.*` for Firefox-specific sidebar/runtime calls. Remaining `chrome.*` APIs are available through Firefox's compatibility namespace. |

Firefox requests `activeTab`, `scripting`, `storage`, `unlimitedStorage`, and
`contextMenus`. It requests `<all_urls>` only as an optional host permission when
the user enables a site, and `clipboardWrite` only when copy access is enabled.
The extension does not request `tabs`, `offscreen`, or `sidePanel` permissions.

## Runtime Differences and Limitations

- Firefox's sidebar is window-level, not a per-tab Chrome side panel. The toolbar
  button opens it for the active window; the built-in sidebar controls can also
  show or hide it.
- The OCR host lives in that sidebar. Closing the sidebar closes its iframe and
  releases the loaded model; opening it again initializes the engine on demand.
  Keep the sidebar open while a capture is processing.
- Cross-origin isolation is used by the Chrome build for multi-threaded WASM.
  Firefox's build does not add COOP/COEP settings; without
  `crossOriginIsolated` the engine selects single-threaded WASM. This may be slower.
- WebGPU remains enabled as an automatically detected ONNX Runtime backend. Its
  availability depends on the Firefox version, operating system, and GPU driver;
  WASM is the fallback. No Firefox-specific WebGPU acceleration is assumed.
- Firefox's add-on store and browser-internal pages remain restricted capture
  targets. Firefox Android is not supported because it does not provide the
  desktop sidebar UI used by this build.
- Extension ratings still link to the Chrome Web Store until an AMO listing exists.

## Smoke Test

After temporary installation, test a normal text selection, text inside an image,
a larger paragraph, Formula mode, repeated captures, Copy, and closing/reopening the
sidebar. Use `npm run build:firefox` after changes, then **Reload** the temporary
add-on from `about:debugging`. Firefox's extension errors and background logs are
available from that page's **Inspect** control.