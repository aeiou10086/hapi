import type { CodexCollaborationState } from '@hapi/protocol/types';

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

const TERMINAL_CALL_STATUSES = new Set(['completed', 'failed', 'error', 'canceled', 'cancelled']);
const TERMINAL_AGENT_STATUSES = new Set(['completed', 'failed', 'error', 'canceled', 'cancelled']);

function isTerminalStatus(status: string | undefined, terminalStatuses: Set<string>): boolean {
    if (!status) return false;
    return terminalStatuses.has(status.toLowerCase());
}

export class CodexCollaborationStateTracker {
    private seenCollaboration = false;
    private readonly activeCalls = new Map<string, string | undefined>();
    private readonly childThreads = new Map<string, string | undefined>();
    private completedAt: number | undefined;

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
            this.childThreads.set(threadId, state?.status);
        }
        for (const [threadId, state] of Object.entries(agentStates)) {
            this.childThreads.set(threadId, state?.status);
        }

        const activeChildCount = Array.from(this.childThreads.values())
            .filter((status) => !isTerminalStatus(status, TERMINAL_AGENT_STATUSES))
            .length;

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
            lastEventAt: now,
            ...(this.completedAt !== undefined ? { completedAt: this.completedAt } : {})
        };
    }

    applyThreadStatus(event: CodexThreadStatusEvent): CodexCollaborationState | null {
        if (!this.childThreads.has(event.thread_id)) {
            return null;
        }

        const normalizedStatus = event.status.toLowerCase() === 'idle'
            ? 'completed'
            : event.status;
        this.childThreads.set(event.thread_id, normalizedStatus);

        const now = event.time ?? Date.now();
        const activeChildCount = Array.from(this.childThreads.values())
            .filter((status) => !isTerminalStatus(status, TERMINAL_AGENT_STATUSES))
            .length;
        const active = this.activeCalls.size > 0 || activeChildCount > 0;
        const status: CodexCollaborationState['status'] = active ? 'collaborating' : 'completed';

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
            lastEventAt: now,
            ...(this.completedAt !== undefined ? { completedAt: this.completedAt } : {})
        };
    }
}
