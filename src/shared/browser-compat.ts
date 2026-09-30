import type { Message } from './messages'

declare const __FIREFOX_BUILD__: boolean | undefined

type BrowserApi = typeof chrome & {
  sidebarAction?: { open: () => Promise<void> }
}

const firefoxApi = (globalThis as typeof globalThis & { browser?: BrowserApi }).browser
const firefoxBuild = typeof __FIREFOX_BUILD__ !== 'undefined' && __FIREFOX_BUILD__
const api: BrowserApi = firefoxBuild ? firefoxApi ?? chrome : chrome
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html'

export async function openResultPanel(tabId: number): Promise<void> {
  if (firefoxBuild) {
    if (!api.sidebarAction) throw new Error('Firefox sidebar API is unavailable.')
    await api.sidebarAction.open()
  } else {
    await chrome.sidePanel.open({ tabId })
  }
}

export async function ensureOcrHost(): Promise<void> {
  if (firefoxBuild) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const reply = await api.runtime.sendMessage({ type: 'OCR_HOST_PING' } satisfies Message).catch(() => undefined)
      if (reply?.ok === true) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('The OCR engine is not ready. Reopen the OCR Buddy sidebar and try again.')
  }

  const url = chrome.runtime.getURL(OFFSCREEN_PATH)
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  })
  if (existing.length > 0) return

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.CLIPBOARD],
    justification: 'Run local OCR and copy requested text to the clipboard without requiring panel focus.',
  })
}

export async function openShortcutSettings(): Promise<void> {
  await chrome.tabs.create({ url: firefoxBuild ? 'about:addons' : 'chrome://extensions/shortcuts' })
}

export const shortcutBrowserName = firefoxBuild ? 'Firefox' : 'Chrome'