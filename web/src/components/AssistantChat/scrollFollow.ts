export type ScrollFollowDecision = {
    autoScroll: 'enabled' | 'disabled' | 'unchanged'
    atBottom: boolean
}

export function getScrollFollowDecision(input: {
    distanceFromBottom: number
    thresholdPx: number
    scrolledUp: boolean
    autoScrollEnabled: boolean
}): ScrollFollowDecision {
    const isNearBottom = input.distanceFromBottom < input.thresholdPx
    const isAtBottom = Math.abs(input.distanceFromBottom) < 1

    if (input.scrolledUp && input.distanceFromBottom > 1) {
        return { autoScroll: 'disabled', atBottom: false }
    }
    if (isAtBottom) {
        return { autoScroll: 'enabled', atBottom: true }
    }
    if (!input.autoScrollEnabled) {
        return { autoScroll: 'disabled', atBottom: false }
    }
    if (isNearBottom) {
        return { autoScroll: 'enabled', atBottom: true }
    }
    return { autoScroll: 'disabled', atBottom: false }
}
