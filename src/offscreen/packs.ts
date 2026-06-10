// Language packs for the PP-OCRv5 recognizer. The Latin pack ships inside the
// extension, so the default experience is fully offline. Every other pack is
// downloaded ONCE, only when the user explicitly selects it, from the same
// pinned commit of the Apache-2.0 model repo the bundled models came from
// (public/models/SOURCE.md), then stored in Cache Storage — offline thereafter.
//
// Detection is script-agnostic and stays bundled; a pack swaps only the
// recognizer + its CTC dictionary.
//
// Endpoints: the .onnx binaries are Git-LFS upstream and must use the media
// endpoint; the .txt dictionaries are plain files and must use raw (media
// serves empty bodies for non-LFS paths). Both send `Access-Control-Allow-
// Origin: *`, so the offscreen document can fetch them without host permissions.
//
// Upstream also has an Arabic pack — deliberately NOT offered: the recognizer
// emits glyphs in visual order and our line/spacing reconstruction assumes
// left-to-right, so RTL output would come back scrambled. An honest tool
// abstains rather than ship a language it would corrupt.

const COMMIT = '3a180da5b1a3bab3371d970f4da42cb9b354a9a7'
const REPO = 'PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models'
const MEDIA = `https://media.githubusercontent.com/media/${REPO}/${COMMIT}`
const RAW = `https://raw.githubusercontent.com/${REPO}/${COMMIT}`

export interface LanguagePack {
  /** Apply the Latin-only output folds (homoglyph map, digit-context o→0). */
  latinFold: boolean
  /** Download URLs; undefined = bundled in the extension (the Latin default). */
  remote?: { rec: string; dict: string }
}

/** Standard layout of the multilingual v5 packs in the source repo. */
const multi = (id: string) => ({
  rec: `${MEDIA}/recognition/multi/${id}/v5/${id}_PP-OCRv5_mobile_rec_infer.onnx`,
  dict: `${RAW}/recognition/multi/${id}/v5/ppocrv5_${id}_dict.txt`,
})

export const DEFAULT_PACK = 'latin'

export const PACKS: Record<string, LanguagePack> = {
  latin: { latinFold: true }, // bundled (models/latin_… + ppocrv5_latin_dict.txt)
  en: { latinFold: true, remote: multi('en') },
  // The flagship PP-OCRv5 model: Chinese (simpl.+trad.) + English + Japanese.
  zh: {
    latinFold: false,
    remote: {
      rec: `${MEDIA}/recognition/PP-OCRv5_mobile_rec_infer.onnx`,
      dict: `${RAW}/recognition/ppocrv5_dict.txt`,
    },
  },
  cyrillic: { latinFold: false, remote: multi('cyrillic') },
  eslav: { latinFold: false, remote: multi('eslav') },
  el: { latinFold: false, remote: multi('el') },
  korean: { latinFold: false, remote: multi('korean') },
  th: { latinFold: false, remote: multi('th') },
  devanagari: { latinFold: false, remote: multi('devanagari') },
  ta: { latinFold: false, remote: multi('ta') },
  te: { latinFold: false, remote: multi('te') },
}

const packOf = (id: string): LanguagePack => PACKS[id] ?? PACKS[DEFAULT_PACK]

/** Whether a pack's output should get the Latin-only folds. */
export const latinFold = (id: string): boolean => packOf(id).latinFold

const CACHE_NAME = 'ocr-buddy-packs-v1'

/** Stream a download, reporting progress 0..1 (content-length permitting). */
async function fetchWithProgress(
  url: string,
  onProgress?: (p: number) => void,
): Promise<ArrayBuffer> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`language pack download failed: HTTP ${resp.status}`)
  const total = Number(resp.headers.get('content-length')) || 0
  if (!resp.body || !total) return resp.arrayBuffer()
  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    onProgress?.(Math.min(1, got / total))
  }
  const buf = new Uint8Array(got)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.length
  }
  return buf.buffer
}

/** Cache-first fetch into Cache Storage (unlimitedStorage is granted). */
async function cachedFetch(url: string, onProgress?: (p: number) => void): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE_NAME)
  const hit = await cache.match(url)
  if (hit) return hit.arrayBuffer()
  const buf = await fetchWithProgress(url, onProgress)
  await cache.put(url, new Response(buf.slice(0)))
  return buf
}

const fetchLocal = async (path: string): Promise<ArrayBuffer> =>
  (await fetch(chrome.runtime.getURL(path))).arrayBuffer()

/** Resolve a pack's recognizer + dictionary buffers (bundled or cached/downloaded). */
export async function loadRecognition(
  id: string,
  onProgress?: (p: number) => void,
): Promise<{ recognition: ArrayBuffer; charactersDictionary: ArrayBuffer }> {
  const pack = packOf(id)
  if (!pack.remote) {
    const [recognition, charactersDictionary] = await Promise.all([
      fetchLocal('models/latin_PP-OCRv5_mobile_rec_infer.onnx'),
      fetchLocal('models/ppocrv5_latin_dict.txt'),
    ])
    return { recognition, charactersDictionary }
  }
  // Dictionary first (tiny); the recognizer carries the progress reporting.
  const charactersDictionary = await cachedFetch(pack.remote.dict)
  const recognition = await cachedFetch(pack.remote.rec, onProgress)
  return { recognition, charactersDictionary }
}
