import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    launches: [] as Array<Record<string, unknown>>,
    localLauncherOptions: [] as Array<Record<string, unknown>>,
    sessionScannerCalls: [] as Array<Record<string, unknown>>,
    scannerFailureMessage: 'No Codex session found within 120000ms for cwd c:\\workspace\\project; refusing fallback.'
}));

vi.mock('./codexLocal', () => ({
    codexLocal: async (opts: Record<string, unknown>) => {
        harness.launches.push(opts);
    }
}));

vi.mock('./utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: {
            url: 'http://localhost:0',
            stop: () => {}
        },
        mcpServers: {}
    })
}));

vi.mock('./utils/codexSessionScanner', () => ({
    createCodexSessionScanner: async (opts: {
        onSessionMatchFailed?: (message: string) => void;
    }) => {
        harness.sessionScannerCalls.push(opts as Record<string, unknown>);
        return {
            cleanup: async () => {},
            onNewSession: () => {},
            triggerFailure: () => {
                opts.onSessionMatchFailed?.(harness.scannerFailureMessage);
            }
        };
    }
}));

vi.mock('@/modules/common/launcher/BaseLocalLauncher', () => ({
    BaseLocalLauncher: class {
        readonly control = {
            requestExit: () => {}
        };

        constructor(private readonly opts: { launch: (signal: AbortSignal) => Promise<void> }) {
            harness.localLauncherOptions.push(opts as unknown as Record<string, unknown>);
        }

        async run(): Promise<'exit'> {
            await this.opts.launch(new AbortController().signal);
            return 'exit';
        }
    }
}));

import { codexLocalLauncher } from './codexLocalLauncher';

function createQueueStub() {
    return {
        size: () => 0,
        reset: () => {},
        setOnMessage: () => {}
    };
}

function wait(ms = 0): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSessionStub(permissionMode: 'default' | 'read-only' | 'safe-yolo' | 'yolo', codexArgs?: string[], path = '/tmp/worktree') {
    const sessionEvents: Array<{ type: string; message?: string }> = [];
    const thinkingChanges: boolean[] = [];
    const goalStates: unknown[] = [];
    let agentState: {
        requests: Record<string, unknown>;
        completedRequests: Record<string, unknown>;
    } = {
        requests: {},
        completedRequests: {}
    };
    const rpcHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
    let localLaunchFailure: { message: string; exitReason: 'switch' | 'exit' } | null = null;
    const session: Record<string, unknown> = {
        sessionId: null,
        path,
        startedBy: 'terminal' as const,
        startingMode: 'local' as const,
        codexArgs,
        thinking: false,
        client: {
            rpcHandlerManager: {
                registerHandler: (method: string, handler: (params: unknown) => Promise<unknown> | unknown) => {
                    rpcHandlers.set(method, handler);
                }
            },
            updateAgentState: (handler: (state: typeof agentState) => typeof agentState) => {
                agentState = handler(agentState);
            }
        },
        getPermissionMode: () => permissionMode,
        getModelReasoningEffort: () => null,
        onSessionFound: () => {},
        onThinkingChange: (thinking: boolean) => {
            session.thinking = thinking;
            thinkingChanges.push(thinking);
        },
        setCodexGoalState: (state: unknown) => {
            goalStates.push(state);
        },
        sendSessionEvent: (event: { type: string; message?: string }) => {
            sessionEvents.push(event);
        },
        recordLocalLaunchFailure: (message: string, exitReason: 'switch' | 'exit') => {
            localLaunchFailure = { message, exitReason };
        },
        sendUserMessage: () => {},
        sendAgentMessage: () => {},
        queue: createQueueStub()
    };

    return {
        session,
        sessionEvents,
        thinkingChanges,
        goalStates,
        rpcHandlers,
        getAgentState: () => agentState,
        getLocalLaunchFailure: () => localLaunchFailure
    };
}

describe('codexLocalLauncher', () => {
    afterEach(() => {
        harness.launches = [];
        harness.localLauncherOptions = [];
        harness.sessionScannerCalls = [];
    });

    it('rebuilds approval and sandbox args from yolo mode', async () => {
        const { session } = createSessionStub('yolo', [
            '--sandbox',
            'read-only',
            '--ask-for-approval',
            'untrusted',
            '--model',
            'o3',
            '--full-auto'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]?.codexArgs).toEqual([
            '--ask-for-approval',
            'never',
            '--sandbox',
            'danger-full-access',
            '--model',
            'o3'
        ]);
    });

    it('preserves raw Codex approval flags in default mode', async () => {
        const { session } = createSessionStub('default', [
            '--ask-for-approval',
            'on-request',
            '--sandbox',
            'workspace-write',
            '--model',
            'o3'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]?.codexArgs).toEqual([
            '--ask-for-approval',
            'on-request',
            '--sandbox',
            'workspace-write',
            '--model',
            'o3'
        ]);
    });

    it('keeps sandbox escalation available in safe-yolo mode', async () => {
        const { session } = createSessionStub('safe-yolo', [
            '--ask-for-approval',
            'never',
            '--sandbox',
            'danger-full-access',
            '--model',
            'o3'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]?.codexArgs).toEqual([
            '--ask-for-approval',
            'on-failure',
            '--sandbox',
            'workspace-write',
            '--model',
            'o3'
        ]);
    });

    it('warns on session match failure without aborting local Codex launch', async () => {
        const { session, sessionEvents, getLocalLaunchFailure } = createSessionStub('default', undefined, 'c:\\workspace\\project');

        await codexLocalLauncher(session as never);

        const scannerCall = harness.sessionScannerCalls[0] as { onSessionMatchFailed?: (message: string) => void } | undefined;
        scannerCall?.onSessionMatchFailed?.(harness.scannerFailureMessage);

        expect(harness.launches).toHaveLength(1);
        expect(getLocalLaunchFailure()).toBeNull();
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: `${harness.scannerFailureMessage} Keeping local Codex running; remote transcript sync may be unavailable for this launch.`
        });
    });

    it('treats local launch failures after entering remote mode as switchable', async () => {
        const { session } = createSessionStub('default');
        session.hasEnteredRemoteMode = true;

        await codexLocalLauncher(session as never);

        expect(harness.localLauncherOptions[0]?.startingMode).toBe('remote');
    });

    it('updates thinking state from local Codex transcript events', async () => {
        const { session, thinkingChanges } = createSessionStub('default');

        await codexLocalLauncher(session as never);

        const scannerCall = harness.sessionScannerCalls[0] as {
            onEvent?: (event: unknown) => void;
        } | undefined;

        scannerCall?.onEvent?.({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'run ls' }
        });
        scannerCall?.onEvent?.({
            type: 'response_item',
            payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{}' }
        });
        scannerCall?.onEvent?.({
            type: 'event_msg',
            payload: { type: 'token_count', info: {} }
        });
        scannerCall?.onEvent?.({
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'turn-1' }
        });

        expect(thinkingChanges).toEqual([true, false]);
        expect(session.thinking).toBe(false);
    });

    it('surfaces paused goal resume prompts as request_user_input cards', async () => {
        const { session, getAgentState, rpcHandlers } = createSessionStub('default');

        await codexLocalLauncher(session as never);

        const scannerCall = harness.sessionScannerCalls[0] as {
            onEvent?: (event: unknown) => void;
        } | undefined;

        scannerCall?.onEvent?.({
            type: 'event_msg',
            payload: {
                type: 'thread_goal_updated',
                threadId: 'thread-1',
                goal: {
                    threadId: 'thread-1',
                    objective: 'Prioritize and execute the 60-day Q System mainline tasks',
                    status: 'paused'
                }
            }
        });

        await wait();

        expect(getAgentState().requests).toMatchObject({
            'codex-goal-resume:thread-1': {
                tool: 'request_user_input',
                arguments: {
                    questions: [
                        {
                            id: 'resume_goal',
                            question: expect.stringContaining('Resume paused goal?'),
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
                    ]
                }
            }
        });

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        const answers = {
            resume_goal: {
                answers: ['Resume goal']
            }
        };
        await permissionRpc?.({
            id: 'codex-goal-resume:thread-1',
            approved: true,
            answers
        });

        expect(getAgentState().requests).toEqual({});
        expect(getAgentState().completedRequests).toMatchObject({
            'codex-goal-resume:thread-1': {
                tool: 'request_user_input',
                status: 'approved',
                answers
            }
        });
    });

    it('syncs local Codex goal updates into session runtime state', async () => {
        const { session, goalStates } = createSessionStub('default');

        await codexLocalLauncher(session as never);

        const scannerCall = harness.sessionScannerCalls[0] as {
            onEvent?: (event: unknown) => void;
        } | undefined;

        scannerCall?.onEvent?.({
            type: 'event_msg',
            payload: {
                type: 'thread_goal_updated',
                threadId: 'thread-1',
                goal: {
                    threadId: 'thread-1',
                    objective: 'Ship the MVP',
                    status: 'active',
                    timeUsedSeconds: 73980
                }
            }
        });
        scannerCall?.onEvent?.({
            type: 'event_msg',
            payload: {
                type: 'thread_goal_cleared',
                threadId: 'thread-1'
            }
        });

        expect(goalStates).toEqual([
            {
                threadId: 'thread-1',
                objective: 'Ship the MVP',
                status: 'active',
                timeUsedSeconds: 73980
            },
            undefined
        ]);
    });

    it('does not leave a resume prompt when replayed goal history is already active', async () => {
        const { session, getAgentState } = createSessionStub('default');

        await codexLocalLauncher(session as never);

        const scannerCall = harness.sessionScannerCalls[0] as {
            onEvent?: (event: unknown) => void;
        } | undefined;

        scannerCall?.onEvent?.({
            type: 'event_msg',
            payload: {
                type: 'thread_goal_updated',
                threadId: 'thread-1',
                goal: {
                    threadId: 'thread-1',
                    objective: 'Prioritize and execute the 60-day Q System mainline tasks',
                    status: 'paused'
                }
            }
        });
        scannerCall?.onEvent?.({
            type: 'event_msg',
            payload: {
                type: 'thread_goal_updated',
                threadId: 'thread-1',
                goal: {
                    threadId: 'thread-1',
                    objective: 'Prioritize and execute the 60-day Q System mainline tasks',
                    status: 'active'
                }
            }
        });

        await wait();

        expect(getAgentState().requests).toEqual({});
    });
});
