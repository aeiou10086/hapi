export type ScrollFollowDecision = {
    autoScroll: 'enabled' | 'disabled' | 'unchanged'
    atBottom: boolean
}

export function getScrollFollowDecision(input: {
    distanceFromBottom: number
    thresholdPx: number
    scrolledUp: boolean
    autoScrollEnabled: boolean
    now: number
    suppressAutoScrollUntil: number
}): ScrollFollowDecision {
    const isNearBottom = input.distanceFromBottom < input.thresholdPx
    const suppressingUserScrollAway = input.now < input.suppressAutoScrollUntil

    if (input.scrolledUp && input.distanceFromBottom > 1) {
        return { autoScroll: 'disabled', atBottom: false }
    }
    if (suppressingUserScrollAway) {
        return { autoScroll: 'disabled', atBottom: false }
    }
    if (isNearBottom) {
        return { autoScroll: 'enabled', atBottom: true }
    }
    if (input.autoScrollEnabled) {
        return { autoScroll: 'disabled', atBottom: false }
    }
    return { autoScroll: 'unchanged', atBottom: false }
}
