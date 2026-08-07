import { describe, expect, it } from 'vitest'
import { getScrollFollowDecision } from './scrollFollow'

describe('getScrollFollowDecision', () => {
    it('does not re-enable auto-scroll near the bottom right after the user scrolls upward', () => {
        const decision = getScrollFollowDecision({
            distanceFromBottom: 24,
            thresholdPx: 120,
            scrolledUp: true,
            autoScrollEnabled: false,
        })

        expect(decision.autoScroll).toBe('disabled')
        expect(decision.atBottom).toBe(false)
    })

    it('keeps auto-scroll disabled after the user scroll-away window expires', () => {
        const decision = getScrollFollowDecision({
            distanceFromBottom: 24,
            thresholdPx: 120,
            scrolledUp: false,
            autoScrollEnabled: false,
        })

        expect(decision.autoScroll).toBe('disabled')
        expect(decision.atBottom).toBe(false)
    })

    it('re-enables auto-scroll when the user reaches the actual bottom', () => {
        const decision = getScrollFollowDecision({
            distanceFromBottom: 0,
            thresholdPx: 120,
            scrolledUp: false,
            autoScrollEnabled: false,
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
        })

        expect(decision.autoScroll).toBe('disabled')
        expect(decision.atBottom).toBe(false)
    })
})
