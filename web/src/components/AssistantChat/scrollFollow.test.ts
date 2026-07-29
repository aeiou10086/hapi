import { describe, expect, it } from 'vitest'
import { getScrollFollowDecision } from './scrollFollow'

describe('getScrollFollowDecision', () => {
    it('does not re-enable auto-scroll near the bottom right after the user scrolls upward', () => {
        const decision = getScrollFollowDecision({
            distanceFromBottom: 24,
            thresholdPx: 120,
            scrolledUp: false,
            autoScrollEnabled: false,
            now: 1_000,
            suppressAutoScrollUntil: 1_500,
        })

        expect(decision.autoScroll).toBe('disabled')
        expect(decision.atBottom).toBe(false)
    })

    it('re-enables auto-scroll near the bottom after the user scroll-away window expires', () => {
        const decision = getScrollFollowDecision({
            distanceFromBottom: 24,
            thresholdPx: 120,
            scrolledUp: false,
            autoScrollEnabled: false,
            now: 2_000,
            suppressAutoScrollUntil: 1_500,
        })

        expect(decision.autoScroll).toBe('enabled')
        expect(decision.atBottom).toBe(true)
    })

    it('disables auto-scroll immediately when the viewport moves upward away from the bottom', () => {
        const decision = getScrollFollowDecision({
            distanceFromBottom: 240,
            thresholdPx: 120,
            scrolledUp: true,
            autoScrollEnabled: true,
            now: 2_000,
            suppressAutoScrollUntil: 0,
        })

        expect(decision.autoScroll).toBe('disabled')
        expect(decision.atBottom).toBe(false)
    })
})
