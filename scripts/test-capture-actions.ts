// Run: node --experimental-strip-types scripts/test-capture-actions.ts
// No browser, OCR model, network, or emitted build files. Execute the real modules
// with Chrome/page mocks; TypeScript is already a project dev dependency.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const event = () => {
  const listeners = new Set<(...args: any[]) => any>()
  return {
    addListener: (fn: (...args: any[]) => any) => listeners.add(fn),
    removeListener: (fn: (...args: any[]) => any) => listeners.delete(fn),
    emit: (...args: any[]) => [...listeners].map(fn => fn(...args)),
    listeners,
  }
}

const domEvents = () => {
  const listeners = new Map<string, Set<(event: any) => void>>()
  return {
    addEventListener(type: string, fn: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: (event: any) => void) { listeners.get(type)?.delete(fn) },
    emit(type: string, event: any) { for (const fn of listeners.get(type) ?? []) fn(event) },
  }
}

function harness() {
  let now = 0
  let timerId = 0
  const timers = new Map<number, { at: number; delay: number; fn: () => void }>()
  const messages: any[] = [], calls: any[] = [], scrolls: any[] = []
  const elements: any[] = []
  const windowEvents = domEvents()
  const state = {
    active: 1, doc: 'original', height: 1800, width: 1400, x: 35, y: 260,
    prefs: {} as Record<string, unknown>, captures: 0, rejectOpen: false,
    rejectBroadcast: false, rejectOverlay: false, rejectInjection: false,
    rejectStorage: false, scrollingStuck: false, offscreen: true,
    panelReady: true, panelBusy: false, tabUrl: 'https://example.com/page',
    permission: true, rejectCreate: false, copyOk: true, rejectCreateTab: false,
    onCapture: null as null | (() => void), onTimer: null as null | ((delay: number) => void),
    onQuery: null as null | (() => void),
  }
  const schedule = (fn: () => void, delay = 0) => {
    const id = ++timerId
    timers.set(id, { at: now + delay, delay, fn })
    return id
  }
  const tab = (id: number) => ({ id, windowId: 9, active: id === state.active, url: state.tabUrl })
  const chrome = {
    action: { onClicked: event() }, commands: { onCommand: event() },
    contextMenus: { onClicked: event(), create: (options: any) => { calls.push(['contextMenu', options]) } },
    sidePanel: { open: async (options: any) => {
      calls.push(['open', options])
      if (state.rejectOpen) throw new Error('Panel open rejected')
    } },
    storage: { local: { get: async () => {
      calls.push(['prefs'])
      if (state.rejectStorage) throw new Error('Storage unavailable')
      return { 'sidepanel.prefs': state.prefs }
    } } },
    runtime: {
      id: 'test',
      getManifest: () => ({ version: '2.6.0' }),
      onInstalled: event(), onMessage: event(),
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT', SIDE_PANEL: 'SIDE_PANEL' },
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: async () => state.offscreen ? [{}] : [],
      sendMessage: async (msg: any) => {
        if (state.rejectBroadcast) throw new Error('Receiving end does not exist')
        messages.push(msg)
        if (msg.type === 'PANEL_READY') return { ok: state.panelReady, busy: state.panelBusy }
        if (msg.type === 'OFFSCREEN_COPY_TEXT') return { ok: state.copyOk, error: state.copyOk ? undefined : 'Copy failed' }
      },
    },
    permissions: { contains: async (request: any) => { calls.push(['permission', request]); return state.permission } },
    offscreen: { Reason: { WORKERS: 'WORKERS', CLIPBOARD: 'CLIPBOARD' }, createDocument: async (options: any) => {
      calls.push(['offscreen', options])
      if (state.rejectCreate) throw new Error('Create failed')
      state.offscreen = true
    } },
    tabs: {
      onActivated: event(), onUpdated: event(), onRemoved: event(),
      create: async (options: any) => {
        calls.push(['createTab', options])
        if (state.rejectCreateTab) throw new Error('Tab creation failed')
        return tab(3)
      },
      get: async (id: number) => tab(id),
      query: async (query: any) => {
        calls.push(['query', query]); state.onQuery?.()
        return [tab(state.active)]
      },
      sendMessage: async (id: number, msg: any) => {
        calls.push(['overlay', id, msg])
        if (state.rejectOverlay) throw new Error('No overlay')
      },
      captureVisibleTab: async (...args: any[]) => {
        state.captures++; calls.push(['capture', ...args]); state.onCapture?.()
        return `data:image/png;base64,tile${state.captures}`
      },
    },
    scripting: { executeScript: async ({ target, func, args = [], files }: any) => {
      calls.push(['inject', target, files])
      if (state.rejectInjection) throw new Error('Cannot access contents of url')
      if (target.documentIds && !target.documentIds.includes(state.doc)) throw new Error('No document with id')
      if (files) return []
      // Serialize as Chrome does: an injected function cannot use module closures.
      const result = await vm.runInContext(`(${func.toString()})`, context)(...args)
      return [{ frameId: 0, documentId: state.doc, result }]
    } },
  }
  const context = vm.createContext({
    chrome, console, URL, Error, Promise,
    setTimeout: schedule, clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (fn: (time: number) => void) => schedule(() => fn(now), 16),
    cancelAnimationFrame: (id: number) => timers.delete(id),
    performance: { now: () => now },
    document: { ...domEvents(), createElement: () => {
      const element = { ...domEvents(), style: {}, appendChild: () => {}, remove: () => {}, focus: () => {} }
      elements.push(element)
      return element
    }, documentElement: {
      appendChild: () => {},
      get scrollHeight() { return state.height }, get scrollWidth() { return state.width },
    } },
    window: {
      ...windowEvents,
      location: { origin: 'https://example.com' }, devicePixelRatio: 1,
      innerHeight: 800, innerWidth: 1000,
      get scrollX() { return state.x }, get scrollY() { return state.y },
      scrollTo: (x: any, y?: number) => {
        const options = typeof x === 'object' ? x : { left: x, top: y }
        scrolls.push({ ...options, doc: state.doc })
        // Simulate CSS scroll-behavior:smooth: only instant settles immediately.
        if (options.behavior === 'instant' && !state.scrollingStuck) {
          state.x = Math.max(0, Math.min(options.left, state.width - 1000))
          state.y = Math.max(0, Math.min(options.top, state.height - 800))
        }
      },
    },
    fetch: async () => ({ blob: async () => ({}) }),
    createImageBitmap: async () => ({ close: () => {} }),
    OffscreenCanvas: class {
      getContext() { return { drawImage: () => {} } }
      async convertToBlob() { return {} }
    },
    FileReader: class {
      result = 'data:image/png;base64,crop'
      onload = () => {}
      readAsDataURL() { this.onload() }
    },
  })
  const modules = new Map<string, any>()
  function load(path: string): any {
    const file = resolve(root, path)
    if (modules.has(file)) return modules.get(file)
    const module = { exports: {} }
    modules.set(file, module.exports)
    const source = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText
    vm.runInContext(`(function(require,module,exports){${source}\n})`, context, { filename: file })(
      (id: string) => load(resolve(dirname(file), `${id}.ts`)), module, module.exports,
    )
    return module.exports
  }
  async function drain() {
    for (let i = 0; i < 5000; i++) {
      await new Promise(setImmediate)
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) return
      timers.delete(next[0]); now = next[1].at
      state.onTimer?.(next[1].delay); next[1].fn()
    }
    throw new Error('Mock timer loop did not settle')
  }
  async function fullpage() {
    const promise = load('src/background/fullpage.ts').captureFullPage(1, 9)
    // Attach rejection handling before driving the fake timers.
    const result = promise.then((value: any) => ({ value }), (error: Error) => ({ error }))
    await drain()
    const outcome = await result
    if (outcome.error) throw outcome.error
    return outcome.value
  }
  const switchTab = (id: number) => {
    state.active = id; chrome.tabs.onActivated.emit({ tabId: id, windowId: 9 })
  }
  const sender = { id: 'test', url: 'chrome-extension://test/src/sidepanel/index.html' }
  async function request(msg: any, from: any = sender) {
    let response: any
    const keepAlive = chrome.runtime.onMessage.emit(msg, from, (reply: any) => { response = reply })[0]
    await drain()
    return { response, keepAlive }
  }
  return { state, chrome, messages, calls, scrolls, tab, load, drain, fullpage, switchTab, request, sender, elements, windowEvents }
}

const tests: [string, () => Promise<void>][] = []
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn])

test('full page stops at the final viewport and restores both axes instantly', async () => {
  const h = harness()
  const result = await h.fullpage()
  assert.equal(result.tiles.length, 3)
  assert.equal(result.truncated, false)
  assert.deepEqual(h.scrolls.map(s => s.top), [0, 700, 1000, 260])
  assert.ok(h.scrolls.every(s => s.behavior === 'instant'))
  assert.equal(h.state.x, 35); assert.equal(h.state.y, 260)
})

test('a short page captures one tile; a long page caps at twenty', async () => {
  for (const [height, count, truncated] of [[600, 1, false], [14100, 20, false], [100000, 20, true]] as const) {
    const h = harness(); h.state.height = height
    const result = await h.fullpage()
    assert.equal(result.tiles.length, count); assert.equal(result.truncated, truncated)
  }
})

test('capture failure restores x/y and releases tab listeners', async () => {
  const h = harness(); h.state.onCapture = () => { throw new Error('Screenshot failed') }
  await assert.rejects(h.fullpage(), /Screenshot failed/)
  assert.equal(h.scrolls.at(-1)?.left, 35)
  assert.equal(h.scrolls.at(-1)?.top, 260)
  assert.equal(h.state.x, 35); assert.equal(h.state.y, 260)
  assert.equal(h.chrome.tabs.onActivated.listeners.size, 0)
})

test('inactive target aborts without screenshot or scrolling', async () => {
  const h = harness(); h.state.active = 2
  await assert.rejects(h.fullpage(), /tab|capture/i)
  assert.equal(h.state.captures, 0); assert.equal(h.scrolls.length, 0)
})

test('switch-away-and-back during capture is latched and discarded', async () => {
  const h = harness()
  h.state.onCapture = () => { h.switchTab(2); h.switchTab(1) }
  await assert.rejects(h.fullpage(), /tab|capture/i)
  assert.equal(h.state.captures, 1)
  assert.equal(h.state.x, 35); assert.equal(h.state.y, 260)
})

test('rate-limit retry rechecks the target tab before taking pixels', async () => {
  const h = harness()
  h.state.onCapture = () => { if (h.state.captures === 1) throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') }
  h.state.onTimer = delay => { if (delay === 1000) h.switchTab(2) }
  await assert.rejects(h.fullpage(), /tab|capture/i)
  assert.equal(h.state.captures, 1)
})

test('navigation discards capture and never scrolls the replacement document', async () => {
  const h = harness()
  h.state.onCapture = () => {
    h.state.doc = 'replacement'
    h.chrome.tabs.onUpdated.emit(1, { status: 'loading' })
  }
  await assert.rejects(h.fullpage(), /tab|page|capture|document/i)
  assert.ok(h.scrolls.every(s => s.doc === 'original'))
})

test('unsettled scrolling aborts rather than capturing a moving page', async () => {
  const h = harness(); h.state.scrollingStuck = true
  await assert.rejects(h.fullpage(), /scroll/i)
  assert.equal(h.state.captures, 0)
})

test('action opens synchronously before prefs; defaults panel-only; select honors last mode', async () => {
  for (const select of [false, true]) {
    const h = harness(); h.state.prefs = { captureMode: 'formula', ...(select ? { iconAction: 'select' } : {}) }
    h.load('src/background/service-worker.ts')
    h.chrome.action.onClicked.emit(h.tab(1))
    assert.equal(h.calls[0][0], 'open')
    assert.equal(h.calls.some(c => c[0] === 'prefs'), false)
    await h.drain()
    const overlays = h.calls.filter(c => c[0] === 'overlay')
    assert.equal(overlays.length, select ? 1 : 0)
    if (select) assert.equal(overlays[0][2].mode, 'formula')
  }
})

test('native commands use last mode for region/viewport and tiles for full page', async () => {
  for (const command of ['start-capture', 'capture-viewport', 'capture-fullpage']) {
    const h = harness(); h.state.prefs = { captureMode: 'table' }
    h.load('src/background/service-worker.ts')
    h.chrome.commands.onCommand.emit(command, h.tab(1))
    assert.equal(h.calls[0]?.[0], 'open')
    await h.drain()
    if (command === 'start-capture') assert.equal(h.calls.find(c => c[0] === 'overlay')?.[2].mode, 'table')
    else if (command === 'capture-viewport') assert.equal(h.messages.find(m => m.type === 'RUN_OCR')?.mode, 'table')
    else assert.equal(h.messages.filter(m => m.type === 'RUN_OCR_TILES').length, 1)
  }
})

test('busy panel silently denies all native capture entrypoints, including restricted tabs', async () => {
  for (const route of ['action', 'start-capture', 'capture-viewport', 'capture-fullpage', 'context-menu']) {
    for (const url of ['https://example.com/page', 'chrome://settings/']) {
      const h = harness(); h.state.panelBusy = true; h.state.tabUrl = url
      h.state.prefs = { iconAction: 'select' }; h.load('src/background/service-worker.ts')
      if (route === 'action') h.chrome.action.onClicked.emit(h.tab(1))
      else if (route === 'context-menu') h.chrome.contextMenus.onClicked.emit({ menuItemId: 'ocr-image', srcUrl: 'data:image/png;base64,test' }, h.tab(1))
      else h.chrome.commands.onCommand.emit(route, h.tab(1))
      await h.drain()
      assert.equal(h.state.captures, 0)
      assert.equal(h.calls.filter(c => c[0] === 'overlay').length, 0)
      assert.deepEqual(h.messages.map(m => m.type), ['PANEL_READY'], 'busy is not an error or permission/restricted response')
      h.state.panelBusy = false; h.state.tabUrl = 'https://example.com/page'
      h.chrome.commands.onCommand.emit('capture-viewport', h.tab(1))
      await h.drain()
      assert.equal(h.state.captures, 1, 'denied native action must release the worker lock')
    }
  }
})

test('panel-originated selection remains allowed after the panel marks itself busy', async () => {
  const h = harness(); h.state.panelBusy = true; h.load('src/background/service-worker.ts')
  await h.request({ type: 'START_SELECTION', mode: 'quick' })
  assert.equal(h.calls.filter(c => c[0] === 'overlay' && c[2].type === 'SHOW_OVERLAY').length, 1)
  assert.equal(h.messages.filter(m => m.type === 'PANEL_READY').length, 0)
})

test('explicit viewport tab and overlay sender cannot redirect to the new active tab', async () => {
  for (const type of ['CAPTURE_VIEWPORT', 'CAPTURE_REQUEST']) {
    const h = harness(); h.state.active = 2; h.load('src/background/service-worker.ts')
    h.chrome.runtime.onMessage.emit({ type, tabId: 1, mode: 'quick', origin: 'https://example.com' }, {
      id: 'test', url: 'https://example.com/page', tab: h.tab(1), documentId: 'original',
    })
    await h.drain()
    assert.equal(h.state.captures, 0)
    assert.equal(h.messages.filter(m => m.type === 'RUN_OCR').length, 0)
    assert.ok(h.messages.some(m => m.stage === 'error'))
  }
})

test('a panel opened in a tab preserves its explicit viewport target', async () => {
  const h = harness(); h.load('src/background/service-worker.ts')
  h.chrome.runtime.onMessage.emit({ type: 'CAPTURE_VIEWPORT', tabId: 1, mode: 'table', origin: 'https://example.com' }, {
    ...h.sender, tab: h.tab(2), documentId: 'panel-document',
  })
  await h.drain()
  assert.equal(h.state.captures, 1)
  assert.equal(h.messages.find(m => m.type === 'RUN_OCR')?.mode, 'table')
})

test('content script sender retains authority over a conflicting viewport target', async () => {
  const h = harness(); h.load('src/background/service-worker.ts')
  h.chrome.runtime.onMessage.emit({ type: 'CAPTURE_VIEWPORT', tabId: 2, mode: 'quick', origin: 'https://example.com' }, {
    id: 'test', url: 'https://example.com/page', tab: h.tab(1), documentId: 'original',
  })
  await h.drain()
  assert.equal(h.state.captures, 1)
  assert.equal(h.messages.filter(m => m.type === 'RUN_OCR').length, 1)
})

test('panel tab/document IDs are not used as region content-script identity', async () => {
  const h = harness(); h.load('src/background/service-worker.ts')
  h.chrome.runtime.onMessage.emit({
    type: 'CAPTURE_REQUEST', mode: 'quick', origin: 'https://example.com',
    rect: { x: 0, y: 0, width: 20, height: 20 }, devicePixelRatio: 1,
  }, { ...h.sender, tab: h.tab(2), documentId: 'panel-document' })
  await h.drain()
  assert.equal(h.state.captures, 1)
  assert.equal(h.messages.filter(m => m.type === 'RUN_OCR').length, 1)
})

test('overlapping jobs take only one viewport screenshot', async () => {
  const h = harness(); h.load('src/background/service-worker.ts')
  const msg = { type: 'CAPTURE_VIEWPORT', tabId: 1, mode: 'quick', origin: 'https://example.com' }
  h.chrome.runtime.onMessage.emit(msg, {})
  h.chrome.runtime.onMessage.emit(msg, {})
  await h.drain()
  assert.equal(h.state.captures, 1)
  assert.equal(h.messages.filter(m => m.type === 'RUN_OCR').length, 1)
})

test('entrypoint and absent-panel rejections never become unhandled promises', async () => {
  const h = harness(); h.state.rejectOpen = true; h.state.rejectBroadcast = true
  h.load('src/background/service-worker.ts')
  h.chrome.action.onClicked.emit(h.tab(1))
  h.chrome.commands.onCommand.emit('start-capture', h.tab(1))
  await h.drain()
})

test('commands wait for the panel listener and fail boundedly if it never attaches', async () => {
  for (const eventuallyReady of [true, false]) {
    const h = harness(); h.state.panelReady = false
    h.load('src/background/service-worker.ts')
    h.state.onTimer = delay => {
      if (delay === 50) {
        assert.equal(h.state.captures, 0)
        if (eventuallyReady) h.state.panelReady = true
      }
    }
    h.chrome.commands.onCommand.emit('capture-viewport', h.tab(1))
    await h.drain()
    assert.equal(h.state.captures, eventuallyReady ? 1 : 0)
    const probes = h.messages.filter(m => m.type === 'PANEL_READY').length
    assert.ok(probes >= 2 && probes <= 40)
    if (!eventuallyReady) assert.ok(h.messages.some(m => m.stage === 'error'))
  }
})

test('successful rate retry captures once more and still restores the page', async () => {
  const h = harness(); h.state.height = 800
  h.state.onCapture = () => { if (h.state.captures === 1) throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') }
  const result = await h.fullpage()
  assert.equal(result.tiles.length, 1); assert.equal(h.state.captures, 2)
  assert.equal(h.scrolls.at(-1)?.left, 35)
})

test('failed screenshot and permission terminal both release capture lock', async () => {
  for (const error of ['Screenshot failed', 'activeTab permission required']) {
    const h = harness(); h.load('src/background/service-worker.ts')
    h.state.onCapture = () => { throw new Error(error) }
    const msg = { type: 'CAPTURE_VIEWPORT', tabId: 1, mode: 'quick', origin: 'https://example.com' }
    h.chrome.runtime.onMessage.emit(msg, {})
    await h.drain()
    h.state.onCapture = null
    h.chrome.runtime.onMessage.emit(msg, {})
    await h.drain()
    assert.equal(h.messages.filter(m => m.type === 'RUN_OCR').length, 1)
  }
})

test('selection does not hold a lock while waiting for a user or cancel', async () => {
  const h = harness(); h.load('src/background/service-worker.ts')
  h.chrome.runtime.onMessage.emit({ type: 'START_SELECTION' }, {})
  await h.drain()
  h.chrome.runtime.onMessage.emit({ type: 'CAPTURE_VIEWPORT', tabId: 1, mode: 'quick', origin: '' }, {})
  await h.drain()
  assert.equal(h.state.captures, 1)
})

test('explicit cancel targets the last selected tab, with active-tab fallback after restart', async () => {
  for (const started of [true, false]) {
    const h = harness(); h.load('src/background/service-worker.ts')
    if (started) await h.request({ type: 'START_SELECTION', mode: 'quick' })
    h.switchTab(2)
    await h.request({ type: 'CANCEL_SELECTION' })
    const hides = h.calls.filter(c => c[0] === 'overlay' && c[2].type === 'HIDE_OVERLAY')
    assert.equal(hides.length, 1)
    assert.equal(hides[0][1], started ? 1 : 2)
    assert.equal(h.messages.filter(m => m.type === 'SELECTION_CANCELLED').length, 0, 'content script broadcasts the single cancellation')
    h.chrome.tabs.onRemoved.emit(1)
    await h.drain()
    assert.equal(h.messages.filter(m => m.type === 'SELECTION_CANCELLED').length, 0, 'explicit cancel clears tracking')
  }
})

test('matching selection navigation or closure broadcasts cancellation once', async () => {
  for (const reason of ['loading', 'url', 'removed']) {
    const h = harness(); h.load('src/background/service-worker.ts')
    await h.request({ type: 'START_SELECTION', mode: 'quick' })
    h.chrome.tabs.onUpdated.emit(2, { status: 'loading' })
    h.chrome.tabs.onRemoved.emit(2)
    await h.drain()
    assert.equal(h.messages.filter(m => m.type === 'SELECTION_CANCELLED').length, 0)
    if (reason === 'removed') h.chrome.tabs.onRemoved.emit(1)
    else h.chrome.tabs.onUpdated.emit(1, reason === 'loading' ? { status: 'loading' } : { url: 'https://example.com/new' })
    h.chrome.tabs.onRemoved.emit(1)
    await h.drain()
    assert.equal(h.messages.filter(m => m.type === 'SELECTION_CANCELLED').length, 1)
    h.switchTab(2)
    await h.request({ type: 'CANCEL_SELECTION' })
    assert.equal(h.calls.filter(c => c[0] === 'overlay' && c[2].type === 'HIDE_OVERLAY').at(-1)?.[1], 2)
  }
})

test('capture and content cancellation clear tracked selection before later navigation', async () => {
  for (const type of ['CAPTURE_REQUEST', 'SELECTION_CANCELLED']) {
    const h = harness(); h.load('src/background/service-worker.ts')
    await h.request({ type: 'START_SELECTION', mode: 'quick' })
    await h.request({
      type, mode: 'quick', origin: 'https://example.com',
      rect: { x: 0, y: 0, width: 20, height: 20 }, devicePixelRatio: 1,
    }, { id: 'test', url: 'https://example.com/page', tab: h.tab(1), documentId: 'original' })
    h.chrome.tabs.onUpdated.emit(1, { status: 'loading' })
    await h.drain()
    assert.equal(h.messages.filter(m => m.type === 'SELECTION_CANCELLED').length, 0)
    h.switchTab(2)
    await h.request({ type: 'CANCEL_SELECTION' })
    assert.equal(h.calls.filter(c => c[0] === 'overlay' && c[2].type === 'HIDE_OVERLAY').at(-1)?.[1], 2)
  }
})

test('cancelling an unavailable overlay is quiet and does not lock future work', async () => {
  const h = harness(); h.load('src/background/service-worker.ts')
  await h.request({ type: 'START_SELECTION' })
  h.state.rejectOverlay = true
  await h.request({ type: 'CANCEL_SELECTION' })
  assert.equal(h.messages.filter(m => m.stage === 'error' || m.type === 'NEED_PERMISSION').length, 0)
  h.state.rejectOverlay = false
  await h.request({ type: 'CAPTURE_VIEWPORT', tabId: 1, origin: '', mode: 'quick' })
  assert.equal(h.state.captures, 1)
})

test('permission retry stays pinned to the original viewport', async () => {
  const h = harness(); h.load('src/background/service-worker.ts')
  h.state.onCapture = () => { throw new Error('activeTab permission required') }
  h.chrome.runtime.onMessage.emit({ type: 'CAPTURE_VIEWPORT', mode: 'quick', origin: '' }, {})
  await h.drain()
  h.state.onCapture = null; h.switchTab(2)
  h.chrome.runtime.onMessage.emit({ type: 'PERMISSION_GRANTED' }, {})
  await h.drain()
  assert.equal(h.state.captures, 1)
  assert.equal(h.messages.filter(m => m.type === 'RUN_OCR').length, 0)
})

test('region sender document and tab win; navigation before the request fails closed', async () => {
  for (const doc of ['original', 'replacement']) {
    const h = harness(); h.state.doc = doc; h.load('src/background/service-worker.ts')
    h.chrome.runtime.onMessage.emit({
      type: 'CAPTURE_REQUEST', tabId: 2, mode: 'formula', origin: 'https://example.com',
      rect: { x: 0, y: 0, width: 20, height: 20 }, devicePixelRatio: 1,
    }, { id: 'test', url: 'https://example.com/page', tab: h.tab(1), documentId: 'original' })
    await h.drain()
    assert.equal(h.state.captures, doc === 'original' ? 1 : 0)
    if (doc === 'original') {
      assert.equal(h.messages.find(m => m.type === 'RUN_OCR')?.mode, 'formula')
      assert.equal(h.calls.find(c => c[0] === 'capture')?.[1], 9)
    }
  }
})

test('clipboard validates sender, text and permission before offscreen creation', async () => {
  const cases = [
    { text: 'hi', sender: { id: 'other', url: 'chrome-extension://test/src/sidepanel/index.html' } },
    { text: 'hi', sender: { id: 'test', url: 'https://example.com', tab: { id: 1 } } },
    { text: 'hi', sender: { id: 'test', url: 'https://example.com' } },
    { text: 'hi', sender: { id: 'test', url: 'chrome-extension://other/src/sidepanel/index.html' } },
    { text: 'hi', sender: { id: 'test', url: 'chrome-extension://test/panel', tab: { id: 1 } } },
    { text: 'hi', sender: { id: 'test', url: 'chrome-extension://test/updates.html' } },
    { text: 'hi', sender: { id: 'test', url: 'chrome-extension://test/src/sidepanel/index.html.evil' } },
    { text: 'hi', sender: { id: 'test', url: 'chrome-extension://test/src/sidepanel/index.html/child' } },
    { text: 'hi', sender: { id: 'test', tab: { id: 1 } } },
    { text: 123 }, { text: 'x'.repeat(2_000_001) }, { text: 'hi', permission: false },
  ]
  for (const data of cases) {
    const h = harness(); h.state.offscreen = false; h.state.permission = data.permission ?? true
    h.load('src/background/service-worker.ts')
    const { response } = await h.request({ type: 'COPY_TEXT', text: data.text }, data.sender ?? h.sender)
    assert.equal(response?.ok, false)
    assert.equal(h.calls.filter(c => c[0] === 'offscreen').length, 0)
    assert.equal(h.messages.filter(m => m.type === 'OFFSCREEN_COPY_TEXT').length, 0)
  }
})

test('exact sidepanel page may copy and ensure offscreen when hosted in a tab', async () => {
  for (const suffix of ['', '?test=1#clipboard']) {
    const h = harness(); h.state.offscreen = false; h.load('src/background/service-worker.ts')
    const sender = { ...h.sender, url: h.sender.url + suffix, tab: h.tab(2) }
    const copy = await h.request({ type: 'COPY_TEXT', text: 'panel tab clipboard' }, sender)
    assert.equal(copy.keepAlive, true)
    assert.equal(copy.response?.ok, true)
    assert.equal(h.messages.find(m => m.type === 'OFFSCREEN_COPY_TEXT')?.text, 'panel tab clipboard')
    const ensure = await h.request({ type: 'ENSURE_OFFSCREEN' }, sender)
    assert.equal(ensure.keepAlive, true); assert.equal(ensure.response?.ok, true)
  }
})

test('ensure offscreen rejects web/content-script and foreign extension senders', async () => {
  const h = harness(); h.state.offscreen = false; h.load('src/background/service-worker.ts')
  for (const sender of [
    { id: 'test', url: 'https://example.com', tab: h.tab(1) },
    { id: 'other', url: h.sender.url },
    { id: 'test', url: 'chrome-extension://other/src/sidepanel/index.html', tab: h.tab(1) },
    { id: 'test', tab: h.tab(1) },
  ]) {
    assert.equal((await h.request({ type: 'ENSURE_OFFSCREEN' }, sender)).response?.ok, false)
  }
  assert.equal(h.calls.filter(c => c[0] === 'offscreen').length, 0)
})

test('clipboard forwards with grant, supports max length, reports offscreen failure', async () => {
  for (const ok of [true, false]) {
    const h = harness(); h.state.offscreen = false; h.state.copyOk = ok
    h.load('src/background/service-worker.ts')
    const text = 'x'.repeat(2_000_000)
    const result = await h.request({ type: 'COPY_TEXT', text })
    assert.equal(result.keepAlive, true); assert.equal(result.response?.ok, ok)
    assert.equal(h.messages.find(m => m.type === 'OFFSCREEN_COPY_TEXT')?.text, text)
    assert.deepEqual(Array.from(h.calls.find(c => c[0] === 'offscreen')[1].reasons), ['WORKERS', 'CLIPBOARD'])
    assert.equal(h.messages.filter(m => m.type === 'OCR_STATUS').length, 0)
  }
})

test('concurrent ensure/copy requests create one offscreen document and allow retry after failure', async () => {
  const h = harness(); h.state.offscreen = false; h.load('src/background/service-worker.ts')
  const [ensure, copy] = await Promise.all([h.request({ type: 'ENSURE_OFFSCREEN' }), h.request({ type: 'COPY_TEXT', text: 'hi' })])
  assert.equal(ensure.keepAlive, true); assert.equal(ensure.response?.ok, true); assert.equal(copy.response?.ok, true)
  assert.equal(h.calls.filter(c => c[0] === 'offscreen').length, 1)
  h.state.offscreen = false; h.state.rejectCreate = true
  assert.equal((await h.request({ type: 'ENSURE_OFFSCREEN' })).response?.ok, false)
  h.state.rejectCreate = false
  assert.equal((await h.request({ type: 'ENSURE_OFFSCREEN' })).response?.ok, true)
  assert.equal((await h.request({ type: 'ENSURE_OFFSCREEN' }, { id: 'test', url: 'https://example.com' })).response?.ok, false)
})

test('overlay Escape and click/tiny drag cancel; successful drag only requests capture', async () => {
  for (const action of ['escape', 'click', 'tiny', 'drag']) {
    const h = harness(); h.load('src/content/overlay.ts')
    h.chrome.runtime.onMessage.emit({ type: 'SHOW_OVERLAY', mode: 'table' })
    if (action === 'escape') {
      h.windowEvents.emit('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
      h.windowEvents.emit('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
    } else {
      h.elements[0].emit('mousedown', { clientX: 10, clientY: 10 })
      h.elements[0].emit('mouseup', { clientX: action === 'drag' ? 50 : 10, clientY: action === 'click' ? 10 : 60 })
    }
    await h.drain()
    assert.equal(h.messages.filter(m => m.type === 'SELECTION_CANCELLED').length, action === 'drag' ? 0 : 1)
    assert.equal(h.messages.filter(m => m.type === 'CAPTURE_REQUEST').length, action === 'drag' ? 1 : 0)
    if (action === 'drag') assert.equal(h.messages.find(m => m.type === 'CAPTURE_REQUEST').mode, 'table')
    h.chrome.runtime.onMessage.emit({ type: 'SHOW_OVERLAY', mode: 'quick' })
    assert.equal(h.elements.length, 6, 'teardown permits another selection')
  }
})

test('overlay cancellation safely tolerates a closed panel', async () => {
  const h = harness(); h.state.rejectBroadcast = true; h.load('src/content/overlay.ts')
  h.chrome.runtime.onMessage.emit({ type: 'SHOW_OVERLAY', mode: 'quick' })
  h.windowEvents.emit('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
  await h.drain()
})

test('HIDE_OVERLAY cancels once and cannot complete a cancelled drag', async () => {
  const h = harness(); h.load('src/content/overlay.ts')
  h.chrome.runtime.onMessage.emit({ type: 'SHOW_OVERLAY', mode: 'quick' })
  h.elements[0].emit('mousedown', { clientX: 10, clientY: 10 })
  h.chrome.runtime.onMessage.emit({ type: 'HIDE_OVERLAY' })
  h.chrome.runtime.onMessage.emit({ type: 'HIDE_OVERLAY' })
  h.elements[0].emit('mouseup', { clientX: 80, clientY: 80 })
  await h.drain()
  assert.equal(h.messages.filter(m => m.type === 'SELECTION_CANCELLED').length, 1)
  assert.equal(h.messages.filter(m => m.type === 'CAPTURE_REQUEST').length, 0)
  h.chrome.runtime.onMessage.emit({ type: 'SHOW_OVERLAY', mode: 'quick' })
  assert.equal(h.elements.length, 6)
})

test('only a version-changing extension update opens the bundled changelog', async () => {
  for (const [reason, previousVersion, expected] of [
    ['install', undefined, 0], ['update', '2.5.6', 1], ['update', '2.6.0', 0], ['chrome_update', '2.5.6', 0],
  ] as const) {
    const h = harness(); h.load('src/background/service-worker.ts')
    assert.equal(h.calls.filter(c => c[0] === 'createTab').length, 0, 'worker startup never opens a tab')
    h.chrome.runtime.onInstalled.emit({ reason, previousVersion })
    await h.drain()
    const created = h.calls.filter(c => c[0] === 'createTab')
    assert.equal(created.length, expected)
    if (expected) assert.equal(created[0][1].url, 'chrome-extension://test/updates.html')
    assert.equal(h.calls.find(c => c[0] === 'contextMenu')?.[1].id, 'ocr-image')
  }
})

test('changelog tab rejection does not escape the install listener', async () => {
  const h = harness(); h.state.rejectCreateTab = true; h.load('src/background/service-worker.ts')
  h.chrome.runtime.onInstalled.emit({ reason: 'update', previousVersion: '2.5.6' })
  await h.drain()
})

const unhandled: unknown[] = []
process.on('unhandledRejection', err => unhandled.push(err))
let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    assert.deepEqual(unhandled.splice(0), [], 'No unhandled entrypoint errors')
    console.log(`PASS ${name}`)
  } catch (err) {
    failed++; console.error(`FAIL ${name}: ${(err as Error).message}`)
    unhandled.length = 0
  }
}
console.log(`${tests.length - failed}/${tests.length} capture checks passed`)
process.exitCode = failed ? 1 : 0
