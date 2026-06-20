import assert from 'node:assert/strict'
import { thresholdFor, shouldShowNudge } from '../src/sidepanel/review.ts'

// thresholdFor: early first nudge at 5, then the [10,15,30] cycle cumulatively.
assert.equal(thresholdFor(0), 5)
assert.equal(thresholdFor(1), 15)
assert.equal(thresholdFor(2), 30)
assert.equal(thresholdFor(3), 60)
assert.equal(thresholdFor(4), 70) // cycle restarts: +10
assert.equal(thresholdFor(5), 85)

// First nudge fires at exactly 5 successful captures.
assert.equal(shouldShowNudge({ successCount: 4, nudgeCount: 0, rated: false }), false)
assert.equal(shouldShowNudge({ successCount: 5, nudgeCount: 0, rated: false }), true)

// After one nudge shown, nothing until 15.
assert.equal(shouldShowNudge({ successCount: 14, nudgeCount: 1, rated: false }), false)
assert.equal(shouldShowNudge({ successCount: 15, nudgeCount: 1, rated: false }), true)

// Third at 30; fourth (cycle reset) at 60.
assert.equal(shouldShowNudge({ successCount: 30, nudgeCount: 2, rated: false }), true)
assert.equal(shouldShowNudge({ successCount: 59, nudgeCount: 3, rated: false }), false)
assert.equal(shouldShowNudge({ successCount: 60, nudgeCount: 3, rated: false }), true)

// Rated → never, whatever the counts.
assert.equal(shouldShowNudge({ successCount: 999, nudgeCount: 0, rated: true }), false)

console.log('review: all assertions passed')
