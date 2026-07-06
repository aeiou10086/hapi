import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

const harness = vi.hoisted(() => ({
    notifications: [] as Array<{ method: string; params: unknown }>,
    registerRequestCalls: [] as string[],
    initializeCalls: [] as unknown[],
    startThreadCalls: [] as unknown[],
    startTurnCalls: [] as unknown[],
    goalSetCalls: [] as Array<Record<string, unknown>>,
    currentGoal: {
        threadId: 'thread-anonymous',
        objective: 'Ship the MVP',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 42,
        timeUsedSeconds: 7
    } as Record<string, unknown> | null,
    turnStartedIncludesId: false,
    turnCompletedIncludesId: false,
    startTurnReturnsId: false,
    emitCollaborationBeforeComplete: false,
    emitChildTurnLifecycleDuringParent: false,
    emitChildMessageDuringCollab: false,
    childCollaborationStatus: 'notLoaded',
    turnNotifications: [] as Array<{ method: string; params: unknown }>
}));

vi.mock('./codexAppServerClient', () => {
    class MockCodexAppServerClient {
        private notificationHandler: ((method: string, params: unknown) => void) | null = null;

        async connect(): Promise<void> {}

        async initialize(params: unknown): Promise<{ protocolVersion: number }> {
            harness.initializeCalls.push(params);
            return { protocolVersion: 1 };
        }

        setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void {
            this.notificationHandler = handler;
        }

        registerRequestHandler(method: string): void {
            harness.registerRequestCalls.push(method);
        }

        async startThread(params: unknown): Promise<{ thread: { id: string }; model: string }> {
            harness.startThreadCalls.push(params);
            return { thread: { id: 'thread-anonymous' }, model: 'gpt-5.4' };
        }

        async resumeThread(): Promise<{ thread: { id: string }; model: string }> {
            return { thread: { id: 'thread-anonymous' }, model: 'gpt-5.4' };
        }

        async startTurn(params: unknown): Promise<{ turn: { id?: string } }> {
            harness.startTurnCalls.push(params);
            const turnId = 'turn-current';
            const started = { threadId: 'thread-anonymous', turn: harness.turnStartedIncludesId ? { id: turnId } : {} };
            harness.notifications.push({ method: 'turn/started', params: started });
            this.notificationHandler?.('turn/started', started);

            for (const notification of harness.turnNotifications) {
                harness.notifications.push(notification);
                this.notificationHandler?.(notification.method, notification.params);
            }

            if (harness.emitChildTurnLifecycleDuringParent) {
                const childStarted = { threadId: 'child-thread', turn: { id: 'child-turn' } };
                harness.notifications.push({ method: 'turn/started', params: childStarted });
                this.notificationHandler?.('turn/started', childStarted);

                const childCompleted = { threadId: 'child-thread', status: 'Completed', turn: { id: 'child-turn' } };
                harness.notifications.push({ method: 'turn/completed', params: childCompleted });
                this.notificationHandler?.('turn/completed', childCompleted);
            }

            if (harness.emitCollaborationBeforeComplete) {
                const collaboration = {
                    item: {
                        id: 'collab-1',
                        type: 'collabAgentToolCall',
                        status: 'completed',
                        receiverThreadIds: ['child-thread'],
                        agentsStates: {
                            'child-thread': {
                                status: harness.childCollaborationStatus,
                                message: 'Status: completed.'
                            }
                        }
                    }
                };
                harness.notifications.push({ method: 'item/completed', params: collaboration });
                this.notificationHandler?.('item/completed', collaboration);

                if (harness.emitChildMessageDuringCollab) {
                    const childMessage = {
                        threadId: 'child-thread',
                        item: {
                            id: 'child-message-1',
                            type: 'agentMessage',
                            content: [{ type: 'text', text: 'Child found a gap.' }]
                        }
                    };
                    harness.notifications.push({ method: 'item/completed', params: childMessage });
                    this.notificationHandler?.('item/completed', childMessage);
                }
            }

            const completed = { threadId: 'thread-anonymous', status: 'Completed', turn: harness.turnCompletedIncludesId ? { id: turnId } : {} };
            harness.notifications.push({ method: 'turn/completed', params: completed });
            this.notificationHandler?.('turn/completed', completed);

            return { turn: harness.startTurnReturnsId ? { id: turnId } : {} };
        }

        async interruptTurn(): Promise<Record<string, never>> {
            return {};
        }

        async getThreadGoal(): Promise<{ goal: Record<string, unknown> | null }> {
            return {
                goal: harness.currentGoal
            };
        }

        async setThreadGoal(params: Record<string, unknown>): Promise<{ goal: Record<string, unknown> }> {
            harness.goalSetCalls.push(params);
            return {
                goal: {
                    threadId: 'thread-anonymous',
                    objective: typeof params.objective === 'string' ? params.objective : 'New objective',
                    status: typeof params.status === 'string' ? params.status : 'active',
                    tokenBudget: null,
                    tokensUsed: 0,
                    timeUsedSeconds: 0
                }
            };
        }

        async clearThreadGoal(): Promise<Record<string, never>> {
            return {};
        }

        async disconnect(): Promise<void> {}
    }

    return { CodexAppServerClient: MockCodexAppServerClient };
});

vi.mock('./utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: {
            stop: () => {}
        },
        mcpServers: {}
    })
}));

import { codexRemoteLauncher } from './codexRemoteLauncher';

type FakeAgentState = {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
};

function createMode(overrides: Partial<EnhancedMode> = {}): EnhancedMode {
    return {
        permissionMode: 'default',
        collaborationMode: 'default',
        ...overrides
    };
}

function createSessionStub(initialMessage = 'hello from launcher test', mode = createMode()) {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
    queue.push(initialMessage, mode);
    queue.close();

    const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const codexMessages: unknown[] = [];
    const thinkingChanges: boolean[] = [];
    const collaborationStates: unknown[] = [];
    const goalStates: unknown[] = [];
    const foundSessionIds: string[] = [];
    let currentModel: string | null | undefined;
    let agentState: FakeAgentState = {
        requests: {},
        completedRequests: {}
    };

    const rpcHandlers = new Map<string, (params: unknown) => unknown>();
    const client = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: (params: unknown) => unknown) {
                rpcHandlers.set(method, handler);
            }
        },
        updateAgentState(handler: (state: FakeAgentState) => FakeAgentState) {
            agentState = handler(agentState);
        },
        sendAgentMessage(message: unknown) {
            codexMessages.push(message);
        },
        sendUserMessage(_text: string) {},
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            sessionEvents.push(event);
        }
    };

    const session = {
        path: '/tmp/hapi-update',
        logPath: '/tmp/hapi-update/test.log',
        client,
        queue,
        codexArgs: undefined,
        codexCliOverrides: undefined,
        sessionId: null as string | null,
        thinking: false,
        getPermissionMode() {
            return 'default' as const;
        },
        setModel(nextModel: string | null) {
            currentModel = nextModel;
        },
        getModel() {
            return currentModel;
        },
        onThinkingChange(nextThinking: boolean) {
            session.thinking = nextThinking;
            thinkingChanges.push(nextThinking);
        },
        onSessionFound(id: string) {
            session.sessionId = id;
            foundSessionIds.push(id);
        },
        setCodexCollaborationState(state: unknown) {
            collaborationStates.push(state);
        },
        setCodexGoalState(state: unknown) {
            goalStates.push(state);
        },
        sendAgentMessage(message: unknown) {
            client.sendAgentMessage(message);
        },
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            client.sendSessionEvent(event);
        },
        sendUserMessage(text: string) {
            client.sendUserMessage(text);
        }
    };

    return {
        session,
        sessionEvents,
        codexMessages,
        thinkingChanges,
        foundSessionIds,
        collaborationStates,
        goalStates,
        rpcHandlers,
        getModel: () => currentModel,
        getAgentState: () => agentState
    };
}

describe('codexRemoteLauncher', () => {
    afterEach(() => {
        harness.notifications = [];
        harness.registerRequestCalls = [];
        harness.initializeCalls = [];
        harness.startThreadCalls = [];
        harness.startTurnCalls = [];
        harness.goalSetCalls = [];
        harness.currentGoal = {
            threadId: 'thread-anonymous',
            objective: 'Ship the MVP',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 42,
            timeUsedSeconds: 7
        };
        harness.turnStartedIncludesId = false;
        harness.turnCompletedIncludesId = false;
        harness.startTurnReturnsId = false;
        harness.emitCollaborationBeforeComplete = false;
        harness.emitChildTurnLifecycleDuringParent = false;
        harness.emitChildMessageDuringCollab = false;
        harness.childCollaborationStatus = 'notLoaded';
        harness.turnNotifications = [];
    });

    it('finishes a turn and emits ready when task lifecycle events omit turn_id', async () => {
        const {
            session,
            sessionEvents,
            thinkingChanges,
            foundSessionIds,
            getModel
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(foundSessionIds).toContain('thread-anonymous');
        expect(getModel()).toBe('gpt-5.4');
        expect(harness.initializeCalls).toEqual([{
            clientInfo: {
                name: 'hapi-codex-client',
                version: '1.0.0'
            },
            capabilities: {
                experimentalApi: true
            }
        }]);
        expect(harness.notifications.map((entry) => entry.method)).toEqual(['turn/started', 'turn/completed']);
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(thinkingChanges).toContain(true);
        expect(session.thinking).toBe(false);
    });

    it('starts remote Codex threads with a request_user_input struct config', async () => {
        const { session } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(harness.startThreadCalls[0]).toMatchObject({
            config: {
                'tools.experimental_request_user_input': {}
            }
        });
    });

    it('supports yolo mode in remote Codex parameters without invalid request_user_input config', async () => {
        const { session } = createSessionStub(
            'hello from yolo web session',
            createMode({ permissionMode: 'yolo' })
        );

        await codexRemoteLauncher(session as never);

        expect(harness.startThreadCalls[0]).toMatchObject({
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
            config: {
                'tools.experimental_request_user_input': {}
            }
        });
        expect(harness.startTurnCalls[0]).toMatchObject({
            approvalPolicy: 'never',
            sandboxPolicy: { type: 'dangerFullAccess' }
        });
    });

    it('syncs current app-server goal into session runtime state', async () => {
        const {
            session,
            goalStates
        } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(goalStates).toContainEqual({
            threadId: 'thread-anonymous',
            objective: 'Ship the MVP',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 42,
            timeUsedSeconds: 7
        });
    });

    it('finishes a turn when task_started has turn_id but task_complete omits it', async () => {
        harness.turnStartedIncludesId = true;
        harness.turnCompletedIncludesId = false;
        harness.startTurnReturnsId = true;

        const {
            session,
            sessionEvents,
            thinkingChanges
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(thinkingChanges).toContain(true);
        expect(session.thinking).toBe(false);
    });

    it('clears transient collaboration state when the turn completes', async () => {
        harness.emitCollaborationBeforeComplete = true;

        const {
            session,
            collaborationStates
        } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(collaborationStates.at(-1)).toMatchObject({
            status: 'idle',
            active: false,
            childThreadCount: 0
        });
    });

    it('keeps thinking active when a child thread completes before the parent turn', async () => {
        harness.turnStartedIncludesId = true;
        harness.turnCompletedIncludesId = true;
        harness.startTurnReturnsId = true;
        harness.emitChildTurnLifecycleDuringParent = true;

        const {
            session,
            thinkingChanges
        } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(thinkingChanges).toEqual([true, false]);
        expect(session.thinking).toBe(false);
    });

    it('mirrors child thread messages into collaboration state while preserving the turn', async () => {
        harness.turnStartedIncludesId = true;
        harness.turnCompletedIncludesId = true;
        harness.startTurnReturnsId = true;
        harness.emitCollaborationBeforeComplete = true;
        harness.emitChildMessageDuringCollab = true;

        const {
            session,
            collaborationStates,
            codexMessages
        } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(codexMessages).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'message',
                message: 'Child found a gap.'
            })
        ]));
        expect(collaborationStates).toEqual(expect.arrayContaining([
            expect.objectContaining({
                childThreads: [
                    expect.objectContaining({
                        threadId: 'child-thread',
                        activities: [
                            expect.objectContaining({
                                type: 'message',
                                text: 'Child found a gap.'
                            })
                        ]
                    })
                ]
            })
        ]));
    });

    it('emits a collaboration summary message when all child threads complete', async () => {
        harness.turnStartedIncludesId = true;
        harness.turnCompletedIncludesId = true;
        harness.startTurnReturnsId = true;
        harness.emitCollaborationBeforeComplete = true;
        harness.emitChildMessageDuringCollab = true;
        harness.childCollaborationStatus = 'completed';

        const {
            session,
            codexMessages
        } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(codexMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'codex-collaboration-summary',
                state: expect.objectContaining({
                    status: 'completed',
                    childThreadCount: 1
                })
            })
        ]));
    });

    it('surfaces wrapped Codex function calls as tool-call messages with input', async () => {
        harness.turnNotifications = [{
            method: 'codex/event/response_item',
            params: {
                msg: {
                    type: 'response_item',
                    payload: {
                        type: 'function_call',
                        name: 'update_plan',
                        call_id: 'call-plan',
                        arguments: '{"plan":[{"step":"Ship fix","status":"in_progress"}]}'
                    }
                }
            }
        }];

        const {
            session,
            codexMessages
        } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(codexMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'tool-call',
                name: 'update_plan',
                callId: 'call-plan',
                input: {
                    plan: [{ step: 'Ship fix', status: 'in_progress' }]
                }
            })
        ]));
    });

    it('surfaces wrapped Codex exec_command calls as CodexBash tool-call messages with command input', async () => {
        harness.turnNotifications = [{
            method: 'codex/event/response_item',
            params: {
                msg: {
                    type: 'response_item',
                    payload: {
                        type: 'function_call',
                        name: 'exec_command',
                        call_id: 'call-exec',
                        arguments: '{"cmd":"pwd","workdir":"/tmp/hapi-update"}'
                    }
                }
            }
        }];

        const {
            session,
            codexMessages
        } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(codexMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'tool-call',
                name: 'CodexBash',
                callId: 'call-exec',
                input: expect.objectContaining({
                    cmd: 'pwd',
                    command: 'pwd',
                    workdir: '/tmp/hapi-update',
                    cwd: '/tmp/hapi-update'
                })
            })
        ]));
    });

    it('handles /goal by reading the app-server thread goal', async () => {
        const {
            session,
            codexMessages
        } = createSessionStub('/goal');

        await codexRemoteLauncher(session as never);

        expect(harness.notifications).toEqual([]);
        expect(codexMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'message',
                message: expect.stringContaining('Ship the MVP')
            })
        ]));
        expect(codexMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                message: expect.stringContaining('tokens used 42')
            })
        ]));
    });

    it('handles /goal with an objective through the app-server goal API', async () => {
        const {
            session,
            codexMessages
        } = createSessionStub('/goal New objective');

        await codexRemoteLauncher(session as never);

        expect(harness.notifications).toEqual([]);
        expect(codexMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'message',
                message: expect.stringContaining('Codex goal set')
            })
        ]));
    });

    it('handles /goal clear through the app-server goal API', async () => {
        const {
            session,
            codexMessages
        } = createSessionStub('/goal clear');

        await codexRemoteLauncher(session as never);

        expect(harness.notifications).toEqual([]);
        expect(codexMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'message',
                message: 'Codex goal cleared.'
            })
        ]));
    });

    it('handles /goal pause through the app-server goal API', async () => {
        const {
            session,
            codexMessages
        } = createSessionStub('/goal pause');

        await codexRemoteLauncher(session as never);

        expect(harness.goalSetCalls).toEqual([expect.objectContaining({
            threadId: 'thread-anonymous',
            objective: 'Ship the MVP',
            status: 'paused'
        })]);
        expect(codexMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'message',
                message: expect.stringContaining('Codex goal paused')
            })
        ]));
    });

    it('handles /goal resume through the app-server goal API', async () => {
        const {
            session,
            codexMessages
        } = createSessionStub('/goal resume');

        await codexRemoteLauncher(session as never);

        expect(harness.goalSetCalls).toEqual([expect.objectContaining({
            threadId: 'thread-anonymous',
            objective: 'Ship the MVP',
            status: 'active'
        })]);
        expect(codexMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'message',
                message: expect.stringContaining('Codex goal resumed')
            })
        ]));
    });
});
