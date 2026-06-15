// Merge per-tile OCR prose from a full-page capture into one document.
//
// Tiles are captured top→bottom with a small vertical overlap, so the bottom
// lines of tile N reappear near the top of tile N+1. We find the longest run of
// tile N's trailing lines that occurs as a contiguous block within the head of
// tile N+1, and drop everything up to and including that block from N+1. Lines
// above the matched block in N+1 (a sticky header repeated every tile) are
// dropped along with the overlap. Pure — no DOM, no chrome APIs.

// How many leading lines of a tile may precede the overlap block (a sticky
// header). Beyond this we stop searching and keep the lines (honest: better a
// duplicate than to swallow real content).
const HEADER_SLACK = 6

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ')

/** Index in `b` from which to start appending: drops b[0 .. idx-1] (a leading
 *  header plus the overlap that duplicates the tail of `a`). 0 = append all. */
function seamCut(a: string[], b: string[]): number {
  const maxK = Math.min(a.length, b.length)
  for (let k = maxK; k >= 1; k--) {
    const tail = a.slice(a.length - k).map(norm)
    const limit = Math.min(b.length - k, HEADER_SLACK)
    for (let start = 0; start <= limit; start++) {
      let ok = true
      for (let i = 0; i < k; i++) {
        if (norm(b[start + i]) !== tail[i]) {
          ok = false
          break
        }
      }
      if (ok) return start + k
    }
  }
  return 0
}

export function mergeTiles(tiles: string[]): string {
  const merged: string[] = []
  for (const tile of tiles) {
    const lines = tile.split('\n').map((l) => l.replace(/\s+$/, ''))
    if (lines.every((l) => l.trim() === '')) continue // skip blank tile
    const cut = merged.length ? seamCut(merged, lines) : 0
    for (let i = cut; i < lines.length; i++) merged.push(lines[i])
  }
  return merged.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
