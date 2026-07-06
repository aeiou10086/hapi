import type { CodexCollaborationActivity, CodexCollaborationState } from '@hapi/protocol/types';

export type CodexCollaborationEvent = {
    type: 'codex_collaboration';
    call_id: string;
    tool?: string;
    status?: string;
    sender_thread_id?: string;
    receiver_thread_ids?: string[];
    agents_states?: Record<string, { status?: string; message?: string | null }>;
    time?: number;
};

export type CodexThreadStatusEvent = {
    type: 'codex_thread_status';
    thread_id: string;
    status: string;
    time?: number;
};

export type CodexThreadActivityEvent = {
    thread_id: string;
    activity: CodexCollaborationActivity;
    time?: number;
};

const TERMINAL_CALL_STATUSES = new Set(['completed', 'failed', 'error', 'canceled', 'cancelled']);
const TERMINAL_AGENT_STATUSES = new Set(['completed', 'failed', 'error', 'canceled', 'cancelled']);

type ChildThreadState = {
    status?: string;
    message?: string | null;
    activities?: CodexCollaborationActivity[];
};

const MAX_CHILD_ACTIVITIES = 8;

function isTerminalStatus(status: string | undefined, terminalStatuses: Set<string>): boolean {
    if (!status) return false;
    return terminalStatuses.has(status.toLowerCase());
}

export class CodexCollaborationStateTracker {
    private seenCollaboration = false;
    private readonly activeCalls = new Map<string, string | undefined>();
    private readonly childThreads = new Map<string, ChildThreadState>();
    private completedAt: number | undefined;

    private buildState(now: number): CodexCollaborationState {
        const childThreads = Array.from(this.childThreads.entries()).map(([threadId, state]) => ({
            threadId,
            ...(state.status ? { status: state.status } : {}),
            ...(state.message !== undefined ? { message: state.message } : {}),
            ...(state.activities && state.activities.length > 0 ? { activities: state.activities } : {}),
            active: !isTerminalStatus(state.status, TERMINAL_AGENT_STATUSES)
        }));

        const activeChildCount = childThreads.filter((thread) => thread.active).length;
        const active = this.activeCalls.size > 0 || activeChildCount > 0;
        const status: CodexCollaborationState['status'] = active
            ? 'collaborating'
            : this.seenCollaboration
                ? 'completed'
                : 'idle';

        if (status === 'completed') {
            this.completedAt = now;
        } else {
            this.completedAt = undefined;
        }

        return {
            status,
            active,
            activeCallCount: this.activeCalls.size,
            childThreadCount: this.childThreads.size,
            childThreads,
            lastEventAt: now,
            ...(this.completedAt !== undefined ? { completedAt: this.completedAt } : {})
        };
    }

    reset(time?: number): CodexCollaborationState {
        const now = time ?? Date.now();
        this.seenCollaboration = false;
        this.activeCalls.clear();
        this.childThreads.clear();
        this.completedAt = undefined;

        return {
            status: 'idle',
            active: false,
            activeCallCount: 0,
            childThreadCount: 0,
            childThreads: [],
            lastEventAt: now
        };
    }

    applyEvent(event: CodexCollaborationEvent): CodexCollaborationState {
        const now = event.time ?? Date.now();
        this.seenCollaboration = true;

        if (isTerminalStatus(event.status, TERMINAL_CALL_STATUSES)) {
            this.activeCalls.delete(event.call_id);
        } else {
            this.activeCalls.set(event.call_id, event.status);
        }

        const agentStates = event.agents_states ?? {};
        for (const threadId of event.receiver_thread_ids ?? []) {
            const state = agentStates[threadId];
            const previous = this.childThreads.get(threadId) ?? {};
            this.childThreads.set(threadId, {
                status: state?.status ?? previous.status,
                message: state?.message ?? previous.message,
                activities: previous.activities
            });
        }
        for (const [threadId, state] of Object.entries(agentStates)) {
            const previous = this.childThreads.get(threadId) ?? {};
            this.childThreads.set(threadId, {
                status: state?.status ?? previous.status,
                message: state?.message ?? previous.message,
                activities: previous.activities
            });
        }

        return this.buildState(now);
    }

    applyThreadStatus(event: CodexThreadStatusEvent): CodexCollaborationState | null {
        if (!this.childThreads.has(event.thread_id)) {
            return null;
        }

        const normalizedStatus = event.status.toLowerCase() === 'idle'
            ? 'completed'
            : event.status;
        const previous = this.childThreads.get(event.thread_id) ?? {};
        this.childThreads.set(event.thread_id, {
            ...previous,
            status: normalizedStatus
        });

        const now = event.time ?? Date.now();
        return this.buildState(now);
    }

    applyThreadActivity(event: CodexThreadActivityEvent): CodexCollaborationState | null {
        const previous = this.childThreads.get(event.thread_id);
        if (!previous) {
            return null;
        }

        const activities = [...(previous.activities ?? []), event.activity].slice(-MAX_CHILD_ACTIVITIES);
        this.childThreads.set(event.thread_id, {
            ...previous,
            activities
        });

        const now = event.time ?? event.activity.time ?? Date.now();
        return this.buildState(now);
    }
}
