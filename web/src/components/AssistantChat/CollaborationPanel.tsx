import type { CodexCollaborationState } from '@hapi/protocol/types'

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

export function CollaborationPanel(props: {
    state?: CodexCollaborationState
}) {
    const state = props.state
    if (!state || state.status !== 'collaborating') {
        return null
    }

    const childThreads = state.childThreads ?? []

    return (
        <div className="mx-2 mb-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-card)]/70 px-3 py-2 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${state.active ? 'animate-pulse bg-blue-500' : 'bg-emerald-500'}`} />
                    <span className="text-xs font-medium text-[var(--app-fg)]">
                        Collaborating
                    </span>
                </div>
                <span className="text-[10px] text-[var(--app-hint)]">
                    {summarizeChildThreadCount(state.childThreadCount)}
                </span>
            </div>

            {childThreads.length > 0 ? (
                <div className="space-y-1.5">
                    {childThreads.map((thread) => (
                        <div
                            key={thread.threadId}
                            className="flex items-start justify-between gap-3 rounded-lg bg-[var(--app-bg)]/60 px-2 py-1.5"
                        >
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
                    ))}
                </div>
            ) : null}
        </div>
    )
}
