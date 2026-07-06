import type { SessionCodexGoalState } from '@/api/types';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeCodexGoalState(value: unknown): SessionCodexGoalState | undefined {
    const goal = asRecord(value);
    if (!goal) {
        return undefined;
    }

    const status = asString(goal.status);
    if (!status) {
        return undefined;
    }

    return {
        status,
        ...(asString(goal.threadId ?? goal.thread_id) ? { threadId: asString(goal.threadId ?? goal.thread_id) } : {}),
        ...(asString(goal.objective) ? { objective: asString(goal.objective) } : {}),
        ...(typeof goal.tokenBudget === 'number' || goal.tokenBudget === null ? { tokenBudget: goal.tokenBudget } : {}),
        ...(typeof goal.token_budget === 'number' || goal.token_budget === null ? { tokenBudget: goal.token_budget } : {}),
        ...(asNumber(goal.tokensUsed ?? goal.tokens_used) !== undefined ? { tokensUsed: asNumber(goal.tokensUsed ?? goal.tokens_used) } : {}),
        ...(asNumber(goal.timeUsedSeconds ?? goal.time_used_seconds) !== undefined ? { timeUsedSeconds: asNumber(goal.timeUsedSeconds ?? goal.time_used_seconds) } : {}),
        ...(asNumber(goal.updatedAt ?? goal.updated_at) !== undefined ? { updatedAt: asNumber(goal.updatedAt ?? goal.updated_at) } : {})
    };
}
