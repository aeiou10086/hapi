import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ThreadPrimitive, useThreadViewportStore } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'
import { getScrollFollowDecision } from './scrollFollow'

const USER_SCROLL_AWAY_SUPPRESSION_MS = 1_200

function NewMessagesIndicator(props: { count: number; onClick: () => void }) {
    const { t } = useTranslation()
    if (props.count === 0) {
        return null
    }

    return (
        <button
            onClick={props.onClick}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 bg-[var(--app-button)] text-[var(--app-button-text)] px-3 py-1.5 rounded-full text-sm font-medium shadow-lg animate-bounce-in z-10"
        >
            {t('misc.newMessage', { n: props.count })} &#8595;
        </button>
    )
}

function MessageSkeleton() {
    const { t } = useTranslation()
    const rows = [
        { align: 'end', width: 'w-2/3', height: 'h-10' },
        { align: 'start', width: 'w-3/4', height: 'h-12' },
        { align: 'end', width: 'w-1/2', height: 'h-9' },
        { align: 'start', width: 'w-5/6', height: 'h-14' }
    ]

    return (
        <div role="status" aria-live="polite">
            <span className="sr-only">{t('misc.loadingMessages')}</span>
            <div className="space-y-3 animate-pulse">
                {rows.map((row, index) => (
                    <div key={`skeleton-${index}`} className={row.align === 'end' ? 'flex justify-end' : 'flex justify-start'}>
                        <div className={`${row.height} ${row.width} rounded-xl bg-[var(--app-subtle-bg)]`} />
                    </div>
                ))}
            </div>
        </div>
    )
}

function ViewportStoreCapture(props: {
    storeRef: React.MutableRefObject<{ setState: (s: { isAtBottom: boolean }) => void } | null>
}) {
    const store = useThreadViewportStore()
    useEffect(() => {
        // The library exposes a ReadonlyStore type but the underlying object is
        // a Zustand store with setState — cast to access it. (Library does the
        // same internally via writableStore() in useThreadViewportAutoScroll.js.)
        props.storeRef.current = store as unknown as { setState: (s: { isAtBottom: boolean }) => void }
        return () => {
            props.storeRef.current = null
        }
    }, [store, props.storeRef])
    return null
}

const THREAD_MESSAGE_COMPONENTS = {
    UserMessage: HappyUserMessage,
    AssistantMessage: HappyAssistantMessage,
    SystemMessage: HappySystemMessage
} as const

export function HappyThread(props: {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    onFlushPending: () => void
    onAtBottomChange: (atBottom: boolean) => void
    isLoadingMessages: boolean
    messagesWarning: string | null
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => Promise<unknown>
    pendingCount: number
    rawMessagesCount: number
    normalizedMessagesCount: number
    messagesVersion: number
    forceScrollToken: number
}) {
    const { t } = useTranslation()
    const viewportRef = useRef<HTMLDivElement | null>(null)
    const topSentinelRef = useRef<HTMLDivElement | null>(null)
    const loadLockRef = useRef(false)
    const pendingScrollRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
    const prevLoadingMoreRef = useRef(false)
    const loadStartedRef = useRef(false)
    const isLoadingMoreRef = useRef(props.isLoadingMoreMessages)
    const hasMoreMessagesRef = useRef(props.hasMoreMessages)
    const isLoadingMessagesRef = useRef(props.isLoadingMessages)
    const onLoadMoreRef = useRef(props.onLoadMore)
    const handleLoadMoreRef = useRef<() => void>(() => {})
    const atBottomRef = useRef(true)
    const onAtBottomChangeRef = useRef(props.onAtBottomChange)
    const onFlushPendingRef = useRef(props.onFlushPending)
    const forceScrollTokenRef = useRef(props.forceScrollToken)
    const pendingForceScrollRef = useRef<{ token: number; messagesVersion: number } | null>(null)
    const suppressAutoScrollUntilRef = useRef(0)
    // The library's threadViewportStore — captured by ViewportStoreCapture
    // (a no-op child rendered inside ThreadPrimitive.Viewport). We mirror our
    // "user has scrolled up" decision into the library's `isAtBottom` so its
    // resize callback (`useThreadViewportAutoScroll.js`) doesn't re-pin to
    // bottom when a content reflow races a wheel event — the trigger we kept
    // hitting after Abort messages.
    const viewportStoreRef = useRef<{ setState: (s: { isAtBottom: boolean }) => void } | null>(null)

    // Smart scroll state: autoScroll enabled when user is near bottom
    const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)
    const autoScrollEnabledRef = useRef(autoScrollEnabled)

    // Keep refs in sync with state
    useEffect(() => {
        autoScrollEnabledRef.current = autoScrollEnabled
    }, [autoScrollEnabled])
    useEffect(() => {
        onAtBottomChangeRef.current = props.onAtBottomChange
    }, [props.onAtBottomChange])
    useEffect(() => {
        onFlushPendingRef.current = props.onFlushPending
    }, [props.onFlushPending])
    useEffect(() => {
        hasMoreMessagesRef.current = props.hasMoreMessages
    }, [props.hasMoreMessages])
    useEffect(() => {
        isLoadingMessagesRef.current = props.isLoadingMessages
    }, [props.isLoadingMessages])
    useEffect(() => {
        onLoadMoreRef.current = props.onLoadMore
    }, [props.onLoadMore])

    const enableAutoScroll = useCallback(() => {
        if (!autoScrollEnabledRef.current) {
            autoScrollEnabledRef.current = true
            setAutoScrollEnabled(true)
        }
    }, [])

    const disableAutoScroll = useCallback(() => {
        if (autoScrollEnabledRef.current) {
            autoScrollEnabledRef.current = false
            setAutoScrollEnabled(false)
        }
        viewportStoreRef.current?.setState({ isAtBottom: false })
    }, [])

    const markUserScrollAwayIntent = useCallback(() => {
        suppressAutoScrollUntilRef.current = Date.now() + USER_SCROLL_AWAY_SUPPRESSION_MS
        disableAutoScroll()
        if (atBottomRef.current) {
            atBottomRef.current = false
            onAtBottomChangeRef.current(false)
        }
    }, [disableAutoScroll])

    // Track scroll position to toggle autoScroll (stable listener using refs)
    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        const THRESHOLD_PX = 120
        let lastScrollTop = viewport.scrollTop
        let lastTouchY: number | null = null

        const handleScroll = () => {
            const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
            const scrolledUp = viewport.scrollTop < lastScrollTop
            lastScrollTop = viewport.scrollTop

            if (scrolledUp && distanceFromBottom > 1) {
                suppressAutoScrollUntilRef.current = Date.now() + USER_SCROLL_AWAY_SUPPRESSION_MS
            }

            const decision = getScrollFollowDecision({
                distanceFromBottom,
                thresholdPx: THRESHOLD_PX,
                scrolledUp,
                autoScrollEnabled: autoScrollEnabledRef.current,
                now: Date.now(),
                suppressAutoScrollUntil: suppressAutoScrollUntilRef.current,
            })

            if (decision.autoScroll === 'disabled') {
                // Disable following immediately on upward intent, even inside
                // the "near bottom" threshold. Otherwise streaming resizes can
                // keep snapping back and make history scrolling feel sticky.
                disableAutoScroll()
            } else if (decision.autoScroll === 'enabled') {
                enableAutoScroll()
                viewportStoreRef.current?.setState({ isAtBottom: true })
            }

            if (decision.atBottom !== atBottomRef.current) {
                atBottomRef.current = decision.atBottom
                onAtBottomChangeRef.current(decision.atBottom)
                if (decision.atBottom) {
                    onFlushPendingRef.current()
                }
            }
        }

        const handleWheel = (event: WheelEvent) => {
            if (event.deltaY < 0) {
                markUserScrollAwayIntent()
            }
        }

        const handleTouchStart = (event: TouchEvent) => {
            lastTouchY = event.touches[0]?.clientY ?? null
        }

        const handleTouchMove = (event: TouchEvent) => {
            const nextY = event.touches[0]?.clientY ?? null
            if (lastTouchY !== null && nextY !== null && nextY > lastTouchY) {
                markUserScrollAwayIntent()
            }
            lastTouchY = nextY
        }

        viewport.addEventListener('scroll', handleScroll, { passive: true })
        viewport.addEventListener('wheel', handleWheel, { passive: true })
        viewport.addEventListener('touchstart', handleTouchStart, { passive: true })
        viewport.addEventListener('touchmove', handleTouchMove, { passive: true })
        return () => {
            viewport.removeEventListener('scroll', handleScroll)
            viewport.removeEventListener('wheel', handleWheel)
            viewport.removeEventListener('touchstart', handleTouchStart)
            viewport.removeEventListener('touchmove', handleTouchMove)
        }
    }, [disableAutoScroll, enableAutoScroll, markUserScrollAwayIntent]) // Stable: reads changing values from refs

    // Scroll to bottom handler for the indicator button
    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
        const viewport = viewportRef.current
        if (viewport) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior })
        }
        suppressAutoScrollUntilRef.current = 0
        enableAutoScroll()
        viewportStoreRef.current?.setState({ isAtBottom: true })
        if (!atBottomRef.current) {
            atBottomRef.current = true
            onAtBottomChangeRef.current(true)
        }
        onFlushPendingRef.current()
    }, [enableAutoScroll])

    // Reset state when session changes
    useEffect(() => {
        autoScrollEnabledRef.current = true
        setAutoScrollEnabled(true)
        suppressAutoScrollUntilRef.current = 0
        viewportStoreRef.current?.setState({ isAtBottom: true })
        atBottomRef.current = true
        onAtBottomChangeRef.current(true)
        forceScrollTokenRef.current = props.forceScrollToken
    }, [props.sessionId])

    useEffect(() => {
        if (forceScrollTokenRef.current === props.forceScrollToken) {
            return
        }
        forceScrollTokenRef.current = props.forceScrollToken
        pendingForceScrollRef.current = {
            token: props.forceScrollToken,
            messagesVersion: props.messagesVersion
        }
        scrollToBottom('auto')
    }, [props.forceScrollToken, props.messagesVersion, scrollToBottom])

    useLayoutEffect(() => {
        const pending = pendingForceScrollRef.current
        if (!pending || pending.messagesVersion === props.messagesVersion) {
            return
        }
        pendingForceScrollRef.current = null
        requestAnimationFrame(() => {
            scrollToBottom('auto')
        })
    }, [props.messagesVersion, scrollToBottom])

    const handleLoadMore = useCallback(() => {
        if (isLoadingMessagesRef.current || !hasMoreMessagesRef.current || isLoadingMoreRef.current || loadLockRef.current) {
            return
        }
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        pendingScrollRef.current = {
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight
        }
        loadLockRef.current = true
        loadStartedRef.current = false
        let loadPromise: Promise<unknown>
        try {
            loadPromise = onLoadMoreRef.current()
        } catch (error) {
            pendingScrollRef.current = null
            loadLockRef.current = false
            throw error
        }
        void loadPromise.catch((error) => {
            pendingScrollRef.current = null
            loadLockRef.current = false
            console.error('Failed to load older messages:', error)
        }).finally(() => {
            if (!loadStartedRef.current && !isLoadingMoreRef.current && pendingScrollRef.current) {
                pendingScrollRef.current = null
                loadLockRef.current = false
            }
        })
    }, [])

    useEffect(() => {
        handleLoadMoreRef.current = handleLoadMore
    }, [handleLoadMore])

    useEffect(() => {
        const sentinel = topSentinelRef.current
        const viewport = viewportRef.current
        if (!sentinel || !viewport || !props.hasMoreMessages || props.isLoadingMessages) {
            return
        }
        if (typeof IntersectionObserver === 'undefined') {
            return
        }

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        handleLoadMoreRef.current()
                    }
                }
            },
            {
                root: viewport,
                rootMargin: '200px 0px 0px 0px'
            }
        )

        observer.observe(sentinel)
        return () => observer.disconnect()
    }, [props.hasMoreMessages, props.isLoadingMessages])

    useLayoutEffect(() => {
        const pending = pendingScrollRef.current
        const viewport = viewportRef.current
        if (!pending || !viewport) {
            return
        }
        const delta = viewport.scrollHeight - pending.scrollHeight
        viewport.scrollTop = pending.scrollTop + delta
        pendingScrollRef.current = null
        loadLockRef.current = false
    }, [props.messagesVersion])

    useEffect(() => {
        isLoadingMoreRef.current = props.isLoadingMoreMessages
        if (props.isLoadingMoreMessages) {
            loadStartedRef.current = true
        }
        if (prevLoadingMoreRef.current && !props.isLoadingMoreMessages && pendingScrollRef.current) {
            pendingScrollRef.current = null
            loadLockRef.current = false
        }
        prevLoadingMoreRef.current = props.isLoadingMoreMessages
    }, [props.isLoadingMoreMessages])

    const showSkeleton = props.isLoadingMessages && props.rawMessagesCount === 0 && props.pendingCount === 0

    return (
        <HappyChatProvider value={{
            api: props.api,
            sessionId: props.sessionId,
            metadata: props.metadata,
            disabled: props.disabled,
            onRefresh: props.onRefresh,
            onRetryMessage: props.onRetryMessage
        }}>
            <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col relative">
                <ThreadPrimitive.Viewport
                    asChild
                    autoScroll={autoScrollEnabled}
                    scrollToBottomOnRunStart={false}
                    scrollToBottomOnInitialize={false}
                    scrollToBottomOnThreadSwitch={false}
                >
                    <div ref={viewportRef} className="app-scroll-y min-h-0 flex-1 overflow-x-hidden">
                        <ViewportStoreCapture storeRef={viewportStoreRef} />
                        <div className="mx-auto w-full max-w-content min-w-0 p-3">
                            <div ref={topSentinelRef} className="h-px w-full" aria-hidden="true" />
                            {showSkeleton ? (
                                <MessageSkeleton />
                            ) : (
                                <>
                                    {props.messagesWarning ? (
                                        <div className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs">
                                            {props.messagesWarning}
                                        </div>
                                    ) : null}

                                    {props.hasMoreMessages && !props.isLoadingMessages ? (
                                        <div className="py-1 mb-2">
                                            <div className="mx-auto w-fit">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={handleLoadMore}
                                                    disabled={props.isLoadingMoreMessages || props.isLoadingMessages}
                                                    aria-busy={props.isLoadingMoreMessages}
                                                    className="gap-1.5 text-xs opacity-80 hover:opacity-100"
                                                >
                                                    {props.isLoadingMoreMessages ? (
                                                        <>
                                                            <Spinner size="sm" label={null} className="text-current" />
                                                            {t('misc.loading')}
                                                        </>
                                                    ) : (
                                                        <>
                                                            <span aria-hidden="true">↑</span>
                                                            {t('misc.loadOlder')}
                                                        </>
                                                    )}
                                                </Button>
                                            </div>
                                        </div>
                                    ) : null}

                                    {import.meta.env.DEV && props.normalizedMessagesCount === 0 && props.rawMessagesCount > 0 ? (
                                        <div className="mb-2 rounded-md bg-amber-500/10 p-2 text-xs">
                                            Message normalization returned 0 items for {props.rawMessagesCount} messages (see `web/src/chat/normalize.ts`).
                                        </div>
                                    ) : null}
                                </>
                            )}
                            <div className="happy-thread-messages flex flex-col gap-3">
                                <ThreadPrimitive.Messages components={THREAD_MESSAGE_COMPONENTS} />
                            </div>
                        </div>
                    </div>
                </ThreadPrimitive.Viewport>
                <NewMessagesIndicator count={props.pendingCount} onClick={scrollToBottom} />
            </ThreadPrimitive.Root>
        </HappyChatProvider>
    )
}
