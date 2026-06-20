import assert from 'node:assert/strict'
import { thresholdFor, shouldShowNudge } from '../src/sidepanel/review.ts'

// thresholdFor walks the [10,15,30] cycle cumulatively, resetting after each cycle.
assert.equal(thresholdFor(0), 10)
assert.equal(thresholdFor(1), 25)
assert.equal(thresholdFor(2), 55)
assert.equal(thresholdFor(3), 65) // cycle restarts: +10
assert.equal(thresholdFor(4), 80)
assert.equal(thresholdFor(5), 110)

// First nudge fires at exactly 10 successful captures.
assert.equal(shouldShowNudge({ successCount: 9, nudgeCount: 0, rated: false }), false)
assert.equal(shouldShowNudge({ successCount: 10, nudgeCount: 0, rated: false }), true)

// After one nudge shown, nothing until 25.
assert.equal(shouldShowNudge({ successCount: 24, nudgeCount: 1, rated: false }), false)
assert.equal(shouldShowNudge({ successCount: 25, nudgeCount: 1, rated: false }), true)

// Third at 55; fourth (cycle reset) at 65.
assert.equal(shouldShowNudge({ successCount: 55, nudgeCount: 2, rated: false }), true)
assert.equal(shouldShowNudge({ successCount: 64, nudgeCount: 3, rated: false }), false)
assert.equal(shouldShowNudge({ successCount: 65, nudgeCount: 3, rated: false }), true)

// Rated → never, whatever the counts.
assert.equal(shouldShowNudge({ successCount: 999, nudgeCount: 0, rated: true }), false)

console.log('review: all assertions passed')
