import type { CodexCollaborationState } from '@hapi/protocol/types'
import { useMemo, useRef } from 'react'

function summarizeChildThreadCount(count: number): string {
    return `${count} child thread${count === 1 ? '' : 's'}`
}

function statusTone(status: string | undefined, active: boolean): string {
    const normalized = status?.toLowerCase()
    if (normalized === 'failed' || normalized === 'error') {
        return 'border-red-500/30 bg-red-500/10 text-red-500'
    }
    if (!active || normalized === 'completed') {
        return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
    }
    return 'border-blue-500/30 bg-blue-500/10 text-blue-500'
}

function shortThreadId(threadId: string): string {
    return threadId.length > 18 ? `${threadId.slice(0, 8)}…${threadId.slice(-6)}` : threadId
}

function activityTone(type: string): string {
    if (type === 'tool') return 'text-amber-500'
    if (type === 'result') return 'text-emerald-500'
    if (type === 'reasoning') return 'text-purple-500'
    if (type === 'status') return 'text-blue-500'
    return 'text-[var(--app-fg)]'
}

export function CollaborationPanel(props: {
    state?: CodexCollaborationState
    variant?: 'live' | 'snapshot'
}) {
    const state = props.state
    const variant = props.variant ?? 'live'
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const childThreads = state?.childThreads ?? []
    const showScrollControls = childThreads.length > 2
    const cardBasis = useMemo(() => {
        if (childThreads.length <= 1) return '100%'
        if (childThreads.length === 2) return 'calc((100% - 0.5rem) / 2)'
        return 'calc(100% / 2.2)'
    }, [childThreads.length])

    if (!state || (variant === 'live' && state.status !== 'collaborating')) {
        return null
    }

    const scrollCards = (direction: -1 | 1) => {
        const el = scrollRef.current
        if (!el) return
        el.scrollBy({
            left: direction * Math.max(el.clientWidth * 0.85, 240),
            behavior: 'smooth'
        })
    }

    return (
        <div className="mx-2 mb-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-card)]/70 px-3 py-2 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${state.active ? 'animate-pulse bg-blue-500' : 'bg-emerald-500'}`} />
                    <span className="text-xs font-medium text-[var(--app-fg)]">
                        {variant === 'snapshot' ? 'Collaboration summary' : 'Collaborating'}
                    </span>
                </div>
                <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-[var(--app-hint)]">
                        {summarizeChildThreadCount(state.childThreadCount)}
                    </span>
                    {showScrollControls ? (
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                aria-label="Scroll collaborations left"
                                className="rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                                onClick={() => scrollCards(-1)}
                            >
                                ←
                            </button>
                            <button
                                type="button"
                                aria-label="Scroll collaborations right"
                                className="rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                                onClick={() => scrollCards(1)}
                            >
                                →
                            </button>
                        </div>
                    ) : null}
                </div>
            </div>

            {childThreads.length > 0 ? (
                <div
                    ref={scrollRef}
                    className="app-scroll-x flex gap-2 overflow-x-auto overscroll-x-contain pb-1"
                >
                    {childThreads.map((thread) => (
                        <div
                            key={thread.threadId}
                            className="min-w-0 shrink-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]/60 px-2 py-1.5"
                            style={{ flexBasis: cardBasis }}
                        >
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="truncate font-mono text-[11px] text-[var(--app-fg)]" title={thread.threadId}>
                                        {shortThreadId(thread.threadId)}
                                    </div>
                                    {thread.message ? (
                                        <div className="mt-0.5 line-clamp-2 text-[10px] text-[var(--app-hint)]">
                                            {thread.message}
                                        </div>
                                    ) : null}
                                </div>
                                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${statusTone(thread.status, thread.active)}`}>
                                    {thread.status ?? (thread.active ? 'running' : 'completed')}
                                </span>
                            </div>

                            {thread.activities && thread.activities.length > 0 ? (
                                <div className="mt-2 max-h-32 space-y-1 overflow-y-auto pr-1">
                                    {thread.activities.map((activity) => (
                                        <div key={activity.id} className="rounded-md bg-[var(--app-card)]/70 px-2 py-1">
                                            <div className={`text-[9px] uppercase tracking-wide ${activityTone(activity.type)}`}>
                                                {activity.tool ?? activity.type}
                                            </div>
                                            {activity.text ? (
                                                <div className="mt-0.5 whitespace-pre-wrap break-words text-[10px] leading-snug text-[var(--app-fg)]">
                                                    {activity.text}
                                                </div>
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
