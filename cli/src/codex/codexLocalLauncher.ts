import { logger } from '@/ui/logger';
import { codexLocal } from './codexLocal';
import type { ReasoningEffort } from './appServerTypes';
import { CodexSession } from './session';
import { createCodexSessionScanner } from './utils/codexSessionScanner';
import { convertCodexEvent, type CodexSessionEvent } from './utils/codexEventConverter';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { stripCodexCliOverrides } from './utils/codexCliOverrides';
import { buildCodexPermissionModeCliArgs } from './utils/permissionModeConfig';
import { normalizeCodexGoalState } from './utils/codexGoalState';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';

type GoalResumePermissionResponse = {
    id?: string;
    approved?: boolean;
    reason?: string;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
};

type PausedGoal = {
    threadId: string;
    objective: string;
};

const GOAL_RESUME_QUESTION_ID = 'resume_goal';
const GOAL_RESUME_REQUEST_PREFIX = 'codex-goal-resume:';

export async function codexLocalLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    const resumeSessionId = session.sessionId;
    let scanner: Awaited<ReturnType<typeof createCodexSessionScanner>> | null = null;
    const scannerStartupTimestampMs = Date.now();
    const permissionMode = session.getPermissionMode();
    const goalResumePromptBridge = new LocalCodexGoalResumePromptBridge(session);
    const managedPermissionMode = permissionMode === 'read-only' || permissionMode === 'safe-yolo' || permissionMode === 'yolo'
        ? permissionMode
        : null;
    const codexArgs = managedPermissionMode
        ? [
            ...buildCodexPermissionModeCliArgs(managedPermissionMode),
            ...stripCodexCliOverrides(session.codexArgs)
        ]
        : session.codexArgs;

    // Start hapi hub for MCP bridge (same as remote mode)
    const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
    logger.debug(`[codex-local]: Started hapi MCP bridge server at ${happyServer.url}`);

    const handleSessionFound = (sessionId: string) => {
        session.onSessionFound(sessionId);
        scanner?.onNewSession(sessionId);
    };

    const launcher = new BaseLocalLauncher({
        label: 'codex-local',
        failureLabel: 'Local Codex process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            await codexLocal({
                path: session.path,
                sessionId: resumeSessionId,
                modelReasoningEffort: (session.getModelReasoningEffort() ?? undefined) as ReasoningEffort | undefined,
                onSessionFound: handleSessionFound,
                abort: abortSignal,
                codexArgs,
                mcpServers
            });
        },
        sendFailureMessage: (message) => {
            session.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        },
        abortLogMessage: 'doAbort',
        switchLogMessage: 'doSwitch'
    });

    const handleSessionMatchFailed = (message: string) => {
        logger.warn(`[codex-local]: ${message}`);
        session.sendSessionEvent({
            type: 'message',
            message: `${message} Keeping local Codex running; remote transcript sync may be unavailable for this launch.`
        });
    };

    scanner = await createCodexSessionScanner({
        sessionId: resumeSessionId,
        cwd: session.path,
        startupTimestampMs: scannerStartupTimestampMs,
        onSessionMatchFailed: handleSessionMatchFailed,
        onSessionFound: (sessionId) => {
            session.onSessionFound(sessionId);
        },
        onEvent: (event) => {
            applyLocalCodexThinkingState(session, event, scannerStartupTimestampMs);
            applyLocalCodexGoalState(session, event);
            goalResumePromptBridge.observe(event);
            const converted = convertCodexEvent(event);
            if (converted?.sessionId) {
                session.onSessionFound(converted.sessionId);
                scanner?.onNewSession(converted.sessionId);
            }
            if (converted?.userMessage) {
                session.sendUserMessage(converted.userMessage);
            }
            if (converted?.message) {
                session.sendAgentMessage(converted.message);
            }
        }
    });

    try {
        return await launcher.run();
    } finally {
        await scanner?.cleanup();
        happyServer.stop();
        logger.debug('[codex-local]: Stopped hapi MCP bridge server');
    }
}

class LocalCodexGoalResumePromptBridge {
    private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly session: CodexSession) {
        this.session.client.rpcHandlerManager.registerHandler<GoalResumePermissionResponse, void>('permission', async (response) => {
            this.handlePermissionResponse(response);
        });
    }

    observe(event: CodexSessionEvent): void {
        const goal = extractGoalUpdate(event);
        if (!goal) {
            return;
        }

        if (goal.status === 'paused') {
            const pausedGoal = {
                threadId: goal.threadId,
                objective: goal.objective
            };
            this.schedulePrompt(pausedGoal);
            return;
        }

        this.clearPrompt(goal.threadId);
    }

    private schedulePrompt(goal: PausedGoal): void {
        const existingTimer = this.pendingTimers.get(goal.threadId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
            this.pendingTimers.delete(goal.threadId);
            this.showPrompt(goal);
        }, 0);
        this.pendingTimers.set(goal.threadId, timer);
    }

    private showPrompt(goal: PausedGoal): void {
        const requestId = goalResumeRequestId(goal.threadId);
        const input = {
            questions: [
                {
                    id: GOAL_RESUME_QUESTION_ID,
                    question: `Resume paused goal?\n\nGoal: ${goal.objective}`,
                    options: [
                        {
                            label: 'Resume goal',
                            description: 'Mark it active and continue when idle'
                        },
                        {
                            label: 'Leave paused',
                            description: 'Keep it paused; use /goal resume later'
                        }
                    ]
                }
            ],
            source: 'codex_local_goal_resume',
            threadId: goal.threadId
        };

        this.session.client.updateAgentState((currentState) => {
            const completed = currentState.completedRequests ?? {};
            const existingCompleted = completed[requestId];
            if (existingCompleted?.status === 'approved') {
                return currentState;
            }

            return {
                ...currentState,
                requests: {
                    ...(currentState.requests ?? {}),
                    [requestId]: {
                        tool: 'request_user_input',
                        arguments: input,
                        createdAt: Date.now()
                    }
                }
            };
        });
    }

    private clearPrompt(threadId: string): void {
        const timer = this.pendingTimers.get(threadId);
        if (timer) {
            clearTimeout(timer);
            this.pendingTimers.delete(threadId);
        }

        const requestId = goalResumeRequestId(threadId);
        this.session.client.updateAgentState((currentState) => {
            const requests = currentState.requests ?? {};
            if (!requests[requestId]) {
                return currentState;
            }
            const nextRequests = { ...requests };
            delete nextRequests[requestId];
            return {
                ...currentState,
                requests: nextRequests
            };
        });
    }

    private handlePermissionResponse(response: GoalResumePermissionResponse): void {
        const requestId = asString(response.id);
        if (!requestId || !requestId.startsWith(GOAL_RESUME_REQUEST_PREFIX)) {
            return;
        }

        this.session.client.updateAgentState((currentState) => {
            const request = currentState.requests?.[requestId];
            if (!request) {
                return currentState;
            }

            const nextRequests = { ...(currentState.requests ?? {}) };
            delete nextRequests[requestId];
            const approved = response.approved === true;

            return {
                ...currentState,
                requests: nextRequests,
                completedRequests: {
                    ...(currentState.completedRequests ?? {}),
                    [requestId]: {
                        ...request,
                        completedAt: Date.now(),
                        status: approved ? 'approved' : 'canceled',
                        reason: response.reason,
                        decision: response.decision ?? (approved ? 'approved' : 'abort'),
                        answers: response.answers
                    }
                }
            };
        });
    }
}

function applyLocalCodexThinkingState(session: CodexSession, event: CodexSessionEvent, startupTimestampMs: number): void {
    if (!isRecentCodexEvent(event, startupTimestampMs)) {
        return;
    }

    if (isLocalCodexTurnEndEvent(event)) {
        if (session.thinking) {
            session.onThinkingChange(false);
        }
        return;
    }

    if (isLocalCodexTurnActivityEvent(event) && !session.thinking) {
        session.onThinkingChange(true);
    }
}

function applyLocalCodexGoalState(session: CodexSession, event: CodexSessionEvent): void {
    if (event.type !== 'event_msg') {
        return;
    }

    const payload = asRecord(event.payload);
    const payloadType = asString(payload?.type);
    if (payloadType === 'thread_goal_cleared') {
        session.setCodexGoalState(undefined);
        return;
    }

    if (payloadType !== 'thread_goal_updated') {
        return;
    }

    const state = normalizeCodexGoalState(payload?.goal);
    if (state) {
        session.setCodexGoalState(state);
    }
}

function isRecentCodexEvent(event: CodexSessionEvent, startupTimestampMs: number): boolean {
    if (!event.timestamp) {
        return true;
    }
    const timestampMs = Date.parse(event.timestamp);
    if (Number.isNaN(timestampMs)) {
        return true;
    }
    return timestampMs >= startupTimestampMs;
}

function isLocalCodexTurnEndEvent(event: CodexSessionEvent): boolean {
    const payload = asRecord(event.payload);
    const payloadType = asString(payload?.type);
    return event.type === 'event_msg'
        && (
            payloadType === 'task_complete'
            || payloadType === 'turn_aborted'
            || payloadType === 'task_failed'
        );
}

function isLocalCodexTurnActivityEvent(event: CodexSessionEvent): boolean {
    const payload = asRecord(event.payload);
    const payloadType = asString(payload?.type);

    if (event.type === 'event_msg') {
        return payloadType === 'user_message'
            || payloadType === 'agent_message'
            || payloadType === 'agent_reasoning'
            || payloadType === 'agent_reasoning_delta';
    }

    if (event.type === 'response_item') {
        return payloadType === 'function_call'
            || payloadType === 'custom_tool_call'
            || payloadType === 'function_call_output'
            || payloadType === 'custom_tool_call_output'
            || payloadType === 'reasoning';
    }

    return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function goalResumeRequestId(threadId: string): string {
    return `${GOAL_RESUME_REQUEST_PREFIX}${threadId}`;
}

function extractGoalUpdate(event: CodexSessionEvent): { threadId: string; objective: string; status: string } | null {
    if (event.type !== 'event_msg') {
        return null;
    }

    const payload = asRecord(event.payload);
    if (asString(payload?.type) !== 'thread_goal_updated') {
        return null;
    }

    const goal = asRecord(payload?.goal);
    const threadId = asString(payload?.threadId ?? payload?.thread_id ?? goal?.threadId ?? goal?.thread_id);
    const objective = asString(goal?.objective);
    const status = asString(goal?.status);
    if (!threadId || !objective || !status) {
        return null;
    }

    return { threadId, objective, status };
}
