import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

const harness = vi.hoisted(() => ({
    notifications: [] as Array<{ method: string; params: unknown }>,
    registerRequestCalls: [] as string[],
    initializeCalls: [] as unknown[],
    turnStartedIncludesId: false,
    turnCompletedIncludesId: false,
    startTurnReturnsId: false,
    emitCollaborationBeforeComplete: false,
    emitChildTurnLifecycleDuringParent: false
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

        async startThread(): Promise<{ thread: { id: string }; model: string }> {
            return { thread: { id: 'thread-anonymous' }, model: 'gpt-5.4' };
        }

        async resumeThread(): Promise<{ thread: { id: string }; model: string }> {
            return { thread: { id: 'thread-anonymous' }, model: 'gpt-5.4' };
        }

        async startTurn(): Promise<{ turn: { id?: string } }> {
            const turnId = 'turn-current';
            const started = { threadId: 'thread-anonymous', turn: harness.turnStartedIncludesId ? { id: turnId } : {} };
            harness.notifications.push({ method: 'turn/started', params: started });
            this.notificationHandler?.('turn/started', started);

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
                                status: 'notLoaded',
                                message: 'Status: completed.'
                            }
                        }
                    }
                };
                harness.notifications.push({ method: 'item/completed', params: collaboration });
                this.notificationHandler?.('item/completed', collaboration);
            }

            const completed = { threadId: 'thread-anonymous', status: 'Completed', turn: harness.turnCompletedIncludesId ? { id: turnId } : {} };
            harness.notifications.push({ method: 'turn/completed', params: completed });
            this.notificationHandler?.('turn/completed', completed);

            return { turn: harness.startTurnReturnsId ? { id: turnId } : {} };
        }

        async interruptTurn(): Promise<Record<string, never>> {
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

function createMode(): EnhancedMode {
    return {
        permissionMode: 'default',
        collaborationMode: 'default'
    };
}

function createSessionStub() {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
    queue.push('hello from launcher test', createMode());
    queue.close();

    const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const codexMessages: unknown[] = [];
    const thinkingChanges: boolean[] = [];
    const collaborationStates: unknown[] = [];
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
        harness.turnStartedIncludesId = false;
        harness.turnCompletedIncludesId = false;
        harness.startTurnReturnsId = false;
        harness.emitCollaborationBeforeComplete = false;
        harness.emitChildTurnLifecycleDuringParent = false;
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
});
