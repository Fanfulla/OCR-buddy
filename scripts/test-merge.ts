import assert from 'node:assert/strict'
import { mergeTiles } from '../src/background/merge-tiles.ts'

// 1. Two tiles, no overlap → all lines in order.
assert.equal(
  mergeTiles(['alpha\nbeta', 'gamma\ndelta']),
  'alpha\nbeta\ngamma\ndelta',
)

// 2. Seam overlap: tile 2 repeats the last 2 lines of tile 1 → deduped once.
assert.equal(
  mergeTiles(['one\ntwo\nthree', 'two\nthree\nfour']),
  'one\ntwo\nthree\nfour',
)

// 3. Sticky header at the top of tile 2 (before the overlap) → header dropped too.
assert.equal(
  mergeTiles(['one\ntwo\nthree', 'HEADER\ntwo\nthree\nfour']),
  'one\ntwo\nthree\nfour',
)

// 4. Empty / whitespace-only tile is skipped.
assert.equal(
  mergeTiles(['one\ntwo', '   \n', 'three']),
  'one\ntwo\nthree',
)

// 5. Single tile → passthrough (trimmed).
assert.equal(mergeTiles(['  only\nlines  ']), 'only\nlines')

// 6. Normalized compare ignores trailing whitespace / collapsed spaces at the seam.
assert.equal(
  mergeTiles(['a\nfoo  bar', 'foo bar\nb']),
  'a\nfoo  bar\nb',
)

// 7. Empty input → empty string.
assert.equal(mergeTiles([]), '')

// 8. A short generic line repeated in body text is NOT over-cut: the real
//    multi-line seam wins over a coincidental single-line match.
assert.equal(
  mergeTiles(['intro\nNote\nbody one\nbody two', 'body two\nNote\nconclusion']),
  'intro\nNote\nbody one\nbody two\nNote\nconclusion',
)

console.log('mergeTiles: all assertions passed')
