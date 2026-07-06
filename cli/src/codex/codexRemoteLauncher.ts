import React from 'react';
import { randomUUID } from 'node:crypto';

import { CodexAppServerClient } from './codexAppServerClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { logger } from '@/ui/logger';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { emitReadyIfIdle } from './utils/emitReadyIfIdle';
import type { CodexSession } from './session';
import type { EnhancedMode } from './loop';
import { hasCodexCliOverrides } from './utils/codexCliOverrides';
import { AppServerEventConverter } from './utils/appServerEventConverter';
import { CodexCollaborationStateTracker, type CodexCollaborationEvent, type CodexThreadActivityEvent, type CodexThreadStatusEvent } from './utils/collaborationState';
import { registerAppServerPermissionHandlers } from './utils/appServerPermissionAdapter';
import { buildThreadStartParams, buildTurnStartParams } from './utils/appServerConfig';
import { normalizeCodexGoalState } from './utils/codexGoalState';
import { shouldIgnoreTerminalEvent } from './utils/terminalEventGuard';
import { expandCodexCustomSlashCommand, parseCodexBuiltinSlashCommand, type CodexBuiltinSlashCommand } from './utils/slashCommand';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';

type HappyServer = Awaited<ReturnType<typeof buildHapiMcpBridge>>['server'];
type QueuedMessage = { message: string; mode: EnhancedMode; isolate: boolean; hash: string };

function describeErrorForLog(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            cause: error.cause
        };
    }
    if (error && typeof error === 'object') {
        return error as Record<string, unknown>;
    }
    return { message: String(error) };
}

class CodexRemoteLauncher extends RemoteLauncherBase {
    private readonly session: CodexSession;
    private readonly appServerClient: CodexAppServerClient;
    private permissionHandler: CodexPermissionHandler | null = null;
    private reasoningProcessor: ReasoningProcessor | null = null;
    private diffProcessor: DiffProcessor | null = null;
    private happyServer: HappyServer | null = null;
    private abortController: AbortController = new AbortController();
    private currentThreadId: string | null = null;
    private currentTurnId: string | null = null;

    constructor(session: CodexSession) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.appServerClient = new CodexAppServerClient();
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(CodexDisplay, context);
    }

    private async handleAbort(onAfterAbort?: () => void): Promise<void> {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            if (this.currentThreadId && this.currentTurnId) {
                try {
                    await this.appServerClient.interruptTurn({
                        threadId: this.currentThreadId,
                        turnId: this.currentTurnId
                    });
                } catch (error) {
                    logger.debug('[Codex] Error interrupting app-server turn:', error);
                }
            }
            this.currentTurnId = null;

            this.abortController.abort();
            this.session.queue.reset();
            this.permissionHandler?.reset();
            this.reasoningProcessor?.abort();
            this.diffProcessor?.reset();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            onAfterAbort?.();
            this.abortController = new AbortController();
        }
    }

    private async handleExitFromUi(): Promise<void> {
        logger.debug('[codex-remote]: Exiting agent via Ctrl-C');
        this.exitReason = 'exit';
        this.shouldExit = true;
        await this.handleAbort();
    }

    private async handleSwitchFromUi(): Promise<void> {
        logger.debug('[codex-remote]: Switching to local mode via double space');
        this.exitReason = 'switch';
        this.shouldExit = true;
        await this.handleAbort();
    }

    private async handleSwitchRequest(): Promise<void> {
        this.exitReason = 'switch';
        this.shouldExit = true;
        await this.handleAbort();
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        if (this.session.codexArgs && this.session.codexArgs.length > 0) {
            if (hasCodexCliOverrides(this.session.codexCliOverrides)) {
                logger.debug(`[codex-remote] CLI args include sandbox/approval overrides; other args ` +
                    `are ignored in remote mode.`);
            } else {
                logger.debug(`[codex-remote] Warning: CLI args [${this.session.codexArgs.join(', ')}] are ignored in remote mode. ` +
                    `Remote mode uses message-based configuration (model/sandbox set via web interface).`);
            }
        }

        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;
        const appServerClient = this.appServerClient;
        const appServerEventConverter = new AppServerEventConverter();
        const collaborationStateTracker = new CodexCollaborationStateTracker();

        const normalizeCommand = (value: unknown): string | undefined => {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                return trimmed.length > 0 ? trimmed : undefined;
            }
            if (Array.isArray(value)) {
                const joined = value.filter((part): part is string => typeof part === 'string').join(' ');
                return joined.length > 0 ? joined : undefined;
            }
            return undefined;
        };

        const asRecord = (value: unknown): Record<string, unknown> | null => {
            if (!value || typeof value !== 'object') {
                return null;
            }
            return value as Record<string, unknown>;
        };

        const asString = (value: unknown): string | null => {
            return typeof value === 'string' && value.length > 0 ? value : null;
        };

        const asNumber = (value: unknown): number | null => {
            return typeof value === 'number' && Number.isFinite(value) ? value : null;
        };

        const normalizePatchChanges = (value: unknown): Record<string, unknown> => {
            if (Array.isArray(value)) {
                const changes: Record<string, unknown> = {};
                for (const entry of value) {
                    const record = asRecord(entry);
                    if (!record) continue;
                    const path = asString(record.path ?? record.file ?? record.filePath ?? record.file_path);
                    if (path) {
                        changes[path] = record;
                    }
                }
                return changes;
            }
            return asRecord(value) ?? {};
        };

        const applyResolvedModel = (value: unknown): string | undefined => {
            const resolvedModel = asString(value) ?? undefined;
            if (!resolvedModel) {
                return undefined;
            }
            session.setModel(resolvedModel);
            logger.debug(`[Codex] Resolved app-server model: ${resolvedModel}`);
            return resolvedModel;
        };

        const buildMcpToolName = (server: unknown, tool: unknown): string | null => {
            const serverName = asString(server);
            const toolName = asString(tool);
            if (!serverName || !toolName) {
                return null;
            }
            return `mcp__${serverName}__${toolName}`;
        };

        const formatOutputPreview = (value: unknown): string => {
            if (typeof value === 'string') return value;
            if (typeof value === 'number' || typeof value === 'boolean') return String(value);
            if (value === null || value === undefined) return '';
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        };

        const permissionHandler = new CodexPermissionHandler(session.client, () => {
            const mode = session.getPermissionMode();
            return mode === 'default' || mode === 'read-only' || mode === 'safe-yolo' || mode === 'yolo'
                ? mode
                : undefined;
        }, {
            onRequest: ({ id, toolName, input }) => {
                if (toolName === 'request_user_input') {
                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'request_user_input',
                        callId: id,
                        input,
                        id: randomUUID()
                    });
                    return;
                }

                const inputRecord = input && typeof input === 'object' ? input as Record<string, unknown> : {};
                const message = typeof inputRecord.message === 'string' ? inputRecord.message : undefined;
                const rawCommand = inputRecord.command;
                const command = Array.isArray(rawCommand)
                    ? rawCommand.filter((part): part is string => typeof part === 'string').join(' ')
                    : typeof rawCommand === 'string'
                        ? rawCommand
                        : undefined;
                const cwdValue = inputRecord.cwd;
                const cwd = typeof cwdValue === 'string' && cwdValue.trim().length > 0 ? cwdValue : undefined;

                session.sendAgentMessage({
                    type: 'tool-call',
                    name: 'CodexPermission',
                    callId: id,
                    input: {
                        tool: toolName,
                        message,
                        command,
                        cwd
                    },
                    id: randomUUID()
                });
            },
            onComplete: ({ id, toolName, decision, reason, approved, answers }) => {
                session.sendAgentMessage({
                    type: 'tool-call-result',
                    callId: id,
                    output: toolName === 'request_user_input'
                        ? { answers }
                        : {
                            decision,
                            reason
                        },
                    is_error: !approved,
                    id: randomUUID()
                });
            }
        });
        const reasoningProcessor = new ReasoningProcessor((message) => {
            session.sendAgentMessage(message);
        });
        const diffProcessor = new DiffProcessor((message) => {
            session.sendAgentMessage(message);
        });
        this.permissionHandler = permissionHandler;
        this.reasoningProcessor = reasoningProcessor;
        this.diffProcessor = diffProcessor;
        let readyAfterTurnTimer: ReturnType<typeof setTimeout> | null = null;
        let scheduleReadyAfterTurn: (() => void) | null = null;
        let clearReadyAfterTurnTimer: (() => void) | null = null;
        let turnInFlight = false;
        let allowAnonymousTerminalEvent = false;
        let completedCollaborationSnapshotEmitted = false;
        let lastGoalAnnouncementSignature: string | null = null;
        let goalCommandInFlight = false;

        const goalAnnouncementSignature = (goal: Record<string, unknown> | null): string | null => {
            if (!goal) {
                return null;
            }
            const status = asString(goal.status) ?? '';
            const objective = asString(goal.objective) ?? '';
            return `${status}\n${objective}`;
        };

        const formatGoal = (goal: Record<string, unknown> | null, prefix = 'Goal'): string | null => {
            if (!goal) {
                return null;
            }
            const objective = asString(goal.objective);
            const status = asString(goal.status);
            const tokenBudget = goal.tokenBudget ?? goal.token_budget;
            const tokensUsed = asNumber(goal.tokensUsed ?? goal.tokens_used);
            const timeUsedSeconds = asNumber(goal.timeUsedSeconds ?? goal.time_used_seconds);
            const lines = [
                `${prefix}${status ? ` (${status})` : ''}:`,
                objective ? objective : '(no objective)'
            ];
            const usage: string[] = [];
            if (tokensUsed !== null) {
                usage.push(`tokens used ${tokensUsed}`);
            }
            if (typeof tokenBudget === 'number') {
                usage.push(`budget ${tokenBudget}`);
            } else if (tokenBudget === null) {
                usage.push('budget none');
            }
            if (timeUsedSeconds !== null) {
                usage.push(`time ${timeUsedSeconds}s`);
            }
            if (usage.length > 0) {
                lines.push(`Usage: ${usage.join(', ')}`);
            }
            if (status === 'blocked' || status === 'paused') {
                lines.push('Use /goal resume to continue this goal.');
            }
            return lines.join('\n');
        };

        const announceGoalUpdate = (goal: Record<string, unknown> | null): void => {
            if (!goal) {
                return;
            }
            const signature = goalAnnouncementSignature(goal);
            if (!signature) {
                return;
            }
            if (goalCommandInFlight) {
                lastGoalAnnouncementSignature = signature;
                return;
            }
            if (signature === lastGoalAnnouncementSignature) {
                return;
            }
            lastGoalAnnouncementSignature = signature;
            const message = formatGoal(goal, 'Codex goal');
            if (!message) {
                return;
            }
            messageBuffer.addMessage(message, 'status');
            session.sendAgentMessage({
                type: 'message',
                message,
                id: randomUUID()
            });
        };

        const publishCollaborationState = (state: ReturnType<CodexCollaborationStateTracker['reset']>): void => {
            session.setCodexCollaborationState(state);
            if (
                state.status === 'completed'
                && state.childThreadCount > 0
                && !completedCollaborationSnapshotEmitted
            ) {
                completedCollaborationSnapshotEmitted = true;
                session.sendAgentMessage({
                    type: 'codex-collaboration-summary',
                    state,
                    id: randomUUID()
                });
            }
        };

        const handleCodexEvent = (msg: Record<string, unknown>) => {
            const msgType = asString(msg.type);
            if (!msgType) return;
            const eventTurnId = asString(msg.turn_id ?? msg.turnId);
            const eventThreadId = asString(msg.thread_id ?? msg.threadId);
            const isTerminalEvent = msgType === 'task_complete' || msgType === 'turn_aborted' || msgType === 'task_failed';
            const isLifecycleEvent = msgType === 'task_started' || isTerminalEvent;
            const isNonCurrentThreadLifecycle = isLifecycleEvent
                && Boolean(eventThreadId)
                && Boolean(this.currentThreadId)
                && eventThreadId !== this.currentThreadId;

            const buildChildActivity = (): CodexThreadActivityEvent['activity'] | null => {
                const now = Date.now();
                if (msgType === 'agent_message') {
                    const text = asString(msg.message);
                    return text ? { id: randomUUID(), type: 'message', text, time: now } : null;
                }
                if (msgType === 'agent_reasoning') {
                    const text = asString(msg.text);
                    return text ? { id: randomUUID(), type: 'reasoning', text, time: now } : null;
                }
                if (msgType === 'exec_command_begin') {
                    const command = normalizeCommand(msg.command) ?? 'command';
                    return { id: randomUUID(), type: 'tool', tool: 'CodexBash', text: command, time: now };
                }
                if (msgType === 'exec_command_end') {
                    const output = msg.output ?? msg.error ?? 'Command completed';
                    return { id: randomUUID(), type: 'result', text: formatOutputPreview(output).substring(0, 240), time: now };
                }
                if (msgType === 'patch_apply_begin') {
                    return { id: randomUUID(), type: 'tool', tool: 'CodexPatch', text: 'Applying file changes', time: now };
                }
                if (msgType === 'patch_apply_end') {
                    const success = Boolean(msg.success);
                    const stdout = asString(msg.stdout);
                    const stderr = asString(msg.stderr);
                    return {
                        id: randomUUID(),
                        type: 'result',
                        text: success ? (stdout || 'Files modified successfully') : (stderr || 'Failed to modify files'),
                        time: now
                    };
                }
                if (msgType === 'mcp_tool_call_begin') {
                    const invocation = asRecord(msg.invocation) ?? {};
                    const name = buildMcpToolName(
                        invocation.server ?? invocation.server_name ?? msg.server,
                        invocation.tool ?? invocation.tool_name ?? msg.tool
                    ) ?? 'MCP tool';
                    return { id: randomUUID(), type: 'tool', tool: name, text: name, time: now };
                }
                if (msgType === 'task_started') {
                    return { id: randomUUID(), type: 'status', text: 'Task started', time: now };
                }
                if (msgType === 'task_complete') {
                    return { id: randomUUID(), type: 'status', text: 'Task completed', time: now };
                }
                if (msgType === 'turn_aborted') {
                    return { id: randomUUID(), type: 'status', text: 'Turn aborted', time: now };
                }
                if (msgType === 'task_failed') {
                    const error = asString(msg.error);
                    return { id: randomUUID(), type: 'status', text: error ? `Task failed: ${error}` : 'Task failed', time: now };
                }
                return null;
            };

            const mirrorChildActivity = () => {
                if (!eventThreadId || !this.currentThreadId || eventThreadId === this.currentThreadId) {
                    return;
                }
                const activity = buildChildActivity();
                if (!activity) {
                    return;
                }
                const collaborationState = collaborationStateTracker.applyThreadActivity({
                    thread_id: eventThreadId,
                    activity,
                    time: activity.time
                });
                if (collaborationState) {
                    publishCollaborationState(collaborationState);
                }
            };

            if (isNonCurrentThreadLifecycle) {
                mirrorChildActivity();
                logger.debug(
                    `[Codex] Ignoring ${msgType} lifecycle event for non-current thread; ` +
                    `eventThread=${eventThreadId}, currentThread=${this.currentThreadId ?? 'none'}, ` +
                    `eventTurnId=${eventTurnId ?? 'none'}, activeTurn=${this.currentTurnId ?? 'none'}`
                );
                return;
            }

            mirrorChildActivity();
            if (eventThreadId && this.currentThreadId && eventThreadId !== this.currentThreadId) {
                logger.debug(
                    `[Codex] Mirrored and suppressed child-thread event ${msgType}; ` +
                    `eventThread=${eventThreadId}, currentThread=${this.currentThreadId}`
                );
                return;
            }

            if (msgType === 'thread_started') {
                const threadId = asString(msg.thread_id ?? msg.threadId);
                if (threadId) {
                    this.currentThreadId = threadId;
                    session.onSessionFound(threadId);
                }
                return;
            }

            if (msgType === 'task_started') {
                const turnId = eventTurnId;
                if (turnId) {
                    this.currentTurnId = turnId;
                    allowAnonymousTerminalEvent = false;
                } else if (!this.currentTurnId) {
                    allowAnonymousTerminalEvent = true;
                }
            }

            if (isTerminalEvent) {
                if (shouldIgnoreTerminalEvent({
                    eventTurnId,
                    currentTurnId: this.currentTurnId,
                    turnInFlight,
                    allowAnonymousTerminalEvent
                })) {
                    logger.debug(
                        `[Codex] Ignoring terminal event ${msgType} without matching turn context; ` +
                        `eventTurnId=${eventTurnId ?? 'none'}, activeTurn=${this.currentTurnId ?? 'none'}, ` +
                        `turnInFlight=${turnInFlight}, allowAnonymous=${allowAnonymousTerminalEvent}`
                    );
                    return;
                }
                this.currentTurnId = null;
                allowAnonymousTerminalEvent = false;
            }

            if (msgType === 'agent_message') {
                const message = asString(msg.message);
                if (message) {
                    messageBuffer.addMessage(message, 'assistant');
                }
            } else if (msgType === 'agent_reasoning') {
                const text = asString(msg.text);
                if (text) {
                    messageBuffer.addMessage(`[Thinking] ${text.substring(0, 100)}...`, 'system');
                }
            } else if (msgType === 'exec_command_begin') {
                const command = normalizeCommand(msg.command) ?? 'command';
                messageBuffer.addMessage(`Executing: ${command}`, 'tool');
            } else if (msgType === 'exec_command_end') {
                const output = msg.output ?? msg.error ?? 'Command completed';
                const outputText = formatOutputPreview(output);
                const truncatedOutput = outputText.substring(0, 200);
                messageBuffer.addMessage(
                    `Result: ${truncatedOutput}${outputText.length > 200 ? '...' : ''}`,
                    'result'
                );
            } else if (msgType === 'task_started') {
                messageBuffer.addMessage('Starting task...', 'status');
            } else if (msgType === 'task_complete') {
                messageBuffer.addMessage('Task completed', 'status');
            } else if (msgType === 'turn_aborted') {
                messageBuffer.addMessage('Turn aborted', 'status');
            } else if (msgType === 'task_failed') {
                const error = asString(msg.error);
                messageBuffer.addMessage(error ? `Task failed: ${error}` : 'Task failed', 'status');
            } else if (msgType === 'codex_collaboration') {
                const collaborationState = collaborationStateTracker.applyEvent({
                    ...(msg as CodexCollaborationEvent),
                    time: Date.now()
                });
                publishCollaborationState(collaborationState);
            } else if (msgType === 'codex_thread_status') {
                const collaborationState = collaborationStateTracker.applyThreadStatus({
                    ...(msg as CodexThreadStatusEvent),
                    time: Date.now()
                });
                if (collaborationState) {
                    publishCollaborationState(collaborationState);
                }
            } else if (msgType === 'codex_goal_update') {
                const goal = asRecord(msg.goal);
                session.setCodexGoalState(normalizeCodexGoalState(goal));
                announceGoalUpdate(goal);
            } else if (msgType === 'codex_goal_cleared') {
                session.setCodexGoalState(undefined);
                lastGoalAnnouncementSignature = null;
                if (goalCommandInFlight) {
                    return;
                }
                const message = 'Codex goal cleared.';
                messageBuffer.addMessage(message, 'status');
                session.sendAgentMessage({
                    type: 'message',
                    message,
                    id: randomUUID()
                });
            }

            if (msgType === 'task_started') {
                completedCollaborationSnapshotEmitted = false;
                publishCollaborationState(collaborationStateTracker.reset(Date.now()));
                clearReadyAfterTurnTimer?.();
                turnInFlight = true;
                if (!eventTurnId && !this.currentTurnId) {
                    allowAnonymousTerminalEvent = true;
                }
                if (!session.thinking) {
                    logger.debug('thinking started');
                    session.onThinkingChange(true);
                }
            }
            if (isTerminalEvent) {
                turnInFlight = false;
                allowAnonymousTerminalEvent = false;
                if (session.thinking) {
                    logger.debug('thinking completed');
                    session.onThinkingChange(false);
                }
                publishCollaborationState(collaborationStateTracker.reset(Date.now()));
                diffProcessor.reset();
                appServerEventConverter.reset();
            }

            if (isTerminalEvent && !turnInFlight) {
                scheduleReadyAfterTurn?.();
            } else if (readyAfterTurnTimer && msgType !== 'task_started') {
                scheduleReadyAfterTurn?.();
            }

            if (msgType === 'agent_reasoning_section_break') {
                reasoningProcessor.handleSectionBreak();
            }
            if (msgType === 'agent_reasoning_delta') {
                const delta = asString(msg.delta);
                if (delta) {
                    reasoningProcessor.processDelta(delta);
                }
            }
            if (msgType === 'agent_reasoning') {
                const text = asString(msg.text);
                if (text) {
                    reasoningProcessor.complete(text);
                }
            }
            if (msgType === 'agent_message') {
                const message = asString(msg.message);
                if (message) {
                    session.sendAgentMessage({
                        type: 'message',
                        message,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'exec_command_begin' || msgType === 'exec_approval_request') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const inputs: Record<string, unknown> = { ...msg };
                    delete inputs.type;
                    delete inputs.call_id;
                    delete inputs.callId;

                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'CodexBash',
                        callId: callId,
                        input: inputs,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'exec_command_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const output: Record<string, unknown> = { ...msg };
                    delete output.type;
                    delete output.call_id;
                    delete output.callId;

                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId: callId,
                        output,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'tool_call') {
                const callId = asString(msg.call_id ?? msg.callId);
                const name = asString(msg.name);
                if (callId && name) {
                    session.sendAgentMessage({
                        type: 'tool-call',
                        name,
                        callId,
                        input: msg.input ?? {},
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'tool_call_result') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId,
                        output: msg.output,
                        is_error: Boolean(msg.is_error ?? msg.isError),
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'token_count') {
                session.sendAgentMessage({
                    ...msg,
                    id: randomUUID()
                });
            }
            if (msgType === 'patch_apply_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const changes = normalizePatchChanges(msg.changes);
                    const changeCount = Object.keys(changes).length;
                    const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
                    messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');

                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'CodexPatch',
                        callId: callId,
                        input: {
                            auto_approved: msg.auto_approved ?? msg.autoApproved,
                            changes
                        },
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'patch_apply_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const stdout = asString(msg.stdout);
                    const stderr = asString(msg.stderr);
                    const success = Boolean(msg.success);

                    if (success) {
                        const message = stdout || 'Files modified successfully';
                        messageBuffer.addMessage(message.substring(0, 200), 'result');
                    } else {
                        const errorMsg = stderr || 'Failed to modify files';
                        messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
                    }

                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId: callId,
                        output: {
                            stdout,
                            stderr,
                            success
                        },
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'mcp_tool_call_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                const invocation = asRecord(msg.invocation) ?? {};
                const name = buildMcpToolName(
                    invocation.server ?? invocation.server_name ?? msg.server,
                    invocation.tool ?? invocation.tool_name ?? msg.tool
                );
                if (callId && name) {
                    session.sendAgentMessage({
                        type: 'tool-call',
                        name,
                        callId,
                        input: invocation.arguments ?? invocation.input ?? msg.arguments ?? msg.input ?? {},
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'mcp_tool_call_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                const rawResult = msg.result;
                let output = rawResult;
                let isError = false;
                const resultRecord = asRecord(rawResult);
                if (resultRecord) {
                    if (Object.prototype.hasOwnProperty.call(resultRecord, 'Ok')) {
                        output = resultRecord.Ok;
                    } else if (Object.prototype.hasOwnProperty.call(resultRecord, 'Err')) {
                        output = resultRecord.Err;
                        isError = true;
                    }
                }

                if (callId) {
                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId,
                        output,
                        is_error: isError,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'turn_diff') {
                const diff = asString(msg.unified_diff);
                if (diff) {
                    diffProcessor.processDiff(diff);
                }
            }
        };

        registerAppServerPermissionHandlers({
            client: appServerClient,
            permissionHandler,
            onUserInputRequest: async ({ id, input }) => {
                try {
                    const answers = await permissionHandler.handleUserInputRequest(id, input);
                    return {
                        decision: 'accept',
                        answers
                    };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.debug(`[Codex] request_user_input failed: ${message}`);
                    return {
                        decision: 'cancel'
                    };
                }
            }
        });

        appServerClient.setNotificationHandler((method, params) => {
            const events = appServerEventConverter.handleNotification(method, params);
            for (const event of events) {
                const eventRecord = asRecord(event) ?? { type: undefined };
                handleCodexEvent(eventRecord);
            }
        });

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
        this.happyServer = happyServer;

        function logActiveHandles(tag: string) {
            if (!process.env.DEBUG) return;
            const anyProc: any = process as any;
            const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
            const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
            logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
            try {
                const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
                logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
            } catch {}
        }

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        await appServerClient.connect();
        await appServerClient.initialize({
            clientInfo: {
                name: 'hapi-codex-client',
                version: '1.0.0'
            },
            capabilities: {
                experimentalApi: true
            }
        });

        let hasThread = false;
        let pending: QueuedMessage | null = null;

        const sendCommandMessage = (message: string): void => {
            messageBuffer.addMessage(message, 'status');
            session.sendAgentMessage({
                type: 'message',
                message,
                id: randomUUID()
            });
        };

        const syncCodexGoalStateForThread = async (threadId: string): Promise<void> => {
            try {
                const goalResponse = await appServerClient.getThreadGoal({ threadId });
                session.setCodexGoalState(normalizeCodexGoalState(goalResponse.goal));
            } catch (error) {
                logger.debug('[Codex] Failed to sync thread goal state', describeErrorForLog(error));
            }
        };

        const ensureThread = async (messageMode: EnhancedMode): Promise<string> => {
            if (hasThread && this.currentThreadId) {
                return this.currentThreadId;
            }

            const threadParams = buildThreadStartParams({
                cwd: session.path,
                mode: messageMode,
                mcpServers,
                cliOverrides: session.codexCliOverrides
            });

            const resumeCandidate = session.sessionId;
            let threadId: string | null = null;

            if (resumeCandidate) {
                try {
                    const resumeResponse = await appServerClient.resumeThread({
                        threadId: resumeCandidate,
                        ...threadParams
                    }, {
                        signal: this.abortController.signal
                    });
                    const resumeRecord = asRecord(resumeResponse);
                    const resumeThread = resumeRecord ? asRecord(resumeRecord.thread) : null;
                    threadId = asString(resumeThread?.id) ?? resumeCandidate;
                    applyResolvedModel(resumeRecord?.model);
                    logger.debug(`[Codex] Resumed app-server thread ${threadId}`);
                } catch (error) {
                    logger.warn(`[Codex] Failed to resume app-server thread ${resumeCandidate}, starting new thread`, error);
                }
            }

            if (!threadId) {
                const threadResponse = await appServerClient.startThread(threadParams, {
                    signal: this.abortController.signal
                });
                const threadRecord = asRecord(threadResponse);
                const thread = threadRecord ? asRecord(threadRecord.thread) : null;
                threadId = asString(thread?.id);
                applyResolvedModel(threadRecord?.model);
                if (!threadId) {
                    throw new Error('app-server thread/start did not return thread.id');
                }
            }

            this.currentThreadId = threadId;
            session.onSessionFound(threadId);
            hasThread = true;
            await syncCodexGoalStateForThread(threadId);
            return threadId;
        };

        const markCommandStarted = (turnId?: string | null): void => {
            turnInFlight = true;
            if (turnId) {
                this.currentTurnId = turnId;
                allowAnonymousTerminalEvent = false;
            } else if (!this.currentTurnId) {
                allowAnonymousTerminalEvent = true;
            }
        };

        const handleBuiltinSlashCommand = async (command: CodexBuiltinSlashCommand, messageMode: EnhancedMode): Promise<void> => {
            if (command.kind === 'unsupported') {
                sendCommandMessage(command.reason);
                emitReadyIfIdle({
                    pending,
                    queueSize: () => session.queue.size(),
                    shouldExit: this.shouldExit,
                    sendReady
                });
                return;
            }

            if (command.kind === 'new') {
                this.currentThreadId = null;
                this.currentTurnId = null;
                session.sessionId = null;
                hasThread = false;
                sendCommandMessage('Started a fresh Codex thread. Your next message will continue in the new thread.');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => session.queue.size(),
                    shouldExit: this.shouldExit,
                    sendReady
                });
                return;
            }

            if (command.kind === 'status') {
                const status = [
                    'Codex status:',
                    `- cwd: ${session.path}`,
                    `- thread: ${this.currentThreadId ?? session.sessionId ?? 'not started'}`,
                    `- model: ${session.getModel() ?? 'auto'}`,
                    `- reasoning effort: ${session.getModelReasoningEffort() ?? 'default'}`,
                    `- permission mode: ${session.getPermissionMode() ?? 'default'}`,
                    `- collaboration mode: ${session.getCollaborationMode() ?? 'default'}`,
                    `- state: ${turnInFlight ? 'thinking' : 'idle'}`
                ].join('\n');
                sendCommandMessage(status);
                emitReadyIfIdle({
                    pending,
                    queueSize: () => session.queue.size(),
                    shouldExit: this.shouldExit,
                    sendReady
                });
                return;
            }

            if (command.kind === 'diff') {
                const diffResponse = await appServerClient.gitDiffToRemote({ cwd: session.path });
                const diff = asString(diffResponse.diff) ?? '';
                const message = diff.trim().length > 0
                    ? `Current git diff (${diffResponse.sha ?? 'worktree'}):\n\n\`\`\`diff\n${diff}\n\`\`\``
                    : 'No git diff found for the current worktree.';
                sendCommandMessage(message);
                emitReadyIfIdle({
                    pending,
                    queueSize: () => session.queue.size(),
                    shouldExit: this.shouldExit,
                    sendReady
                });
                return;
            }

            const threadId = await ensureThread(messageMode);

            if (command.kind === 'goal') {
                if (command.action === 'show') {
                    const goalResponse = await appServerClient.getThreadGoal({ threadId });
                    const goal = asRecord(goalResponse.goal);
                    sendCommandMessage(formatGoal(goal, 'Codex goal') ?? 'No Codex goal is currently set.');
                    emitReadyIfIdle({
                        pending,
                        queueSize: () => session.queue.size(),
                        shouldExit: this.shouldExit,
                        sendReady
                    });
                    return;
                }

                if (command.action === 'clear') {
                    goalCommandInFlight = true;
                    try {
                        await appServerClient.clearThreadGoal({ threadId });
                    } finally {
                        goalCommandInFlight = false;
                    }
                    session.setCodexGoalState(undefined);
                    lastGoalAnnouncementSignature = null;
                    sendCommandMessage('Codex goal cleared.');
                    emitReadyIfIdle({
                        pending,
                        queueSize: () => session.queue.size(),
                        shouldExit: this.shouldExit,
                        sendReady
                    });
                    return;
                }

                if (command.action === 'pause' || command.action === 'resume') {
                    const currentGoalResponse = await appServerClient.getThreadGoal({ threadId });
                    const currentGoal = asRecord(currentGoalResponse.goal);
                    const objective = asString(currentGoal?.objective);
                    if (!objective) {
                        sendCommandMessage('No Codex goal is currently set.');
                        emitReadyIfIdle({
                            pending,
                            queueSize: () => session.queue.size(),
                            shouldExit: this.shouldExit,
                            sendReady
                        });
                        return;
                    }
                    const status = command.action === 'pause' ? 'paused' : 'active';
                    const tokenBudget = currentGoal?.tokenBudget ?? currentGoal?.token_budget;
                    const goalResponse = await (async () => {
                        goalCommandInFlight = true;
                        try {
                            return await appServerClient.setThreadGoal({
                                threadId,
                                objective,
                                ...(typeof tokenBudget === 'number' || tokenBudget === null ? { tokenBudget } : {}),
                                status
                            });
                        } finally {
                            goalCommandInFlight = false;
                        }
                    })();
                    const goal = asRecord(goalResponse.goal);
                    session.setCodexGoalState(normalizeCodexGoalState(goal));
                    lastGoalAnnouncementSignature = goalAnnouncementSignature(goal);
                    const message = formatGoal(
                        goal,
                        command.action === 'pause' ? 'Codex goal paused' : 'Codex goal resumed'
                    ) ?? (command.action === 'pause' ? 'Codex goal paused.' : 'Codex goal resumed.');
                    sendCommandMessage(message);
                    emitReadyIfIdle({
                        pending,
                        queueSize: () => session.queue.size(),
                        shouldExit: this.shouldExit,
                        sendReady
                    });
                    return;
                }

                if (command.action === 'set' && command.objective) {
                    const objective = command.objective;
                    const goalResponse = await (async () => {
                        goalCommandInFlight = true;
                        try {
                            return await appServerClient.setThreadGoal({
                                threadId,
                                objective
                            });
                        } finally {
                            goalCommandInFlight = false;
                        }
                    })();
                    const goal = asRecord(goalResponse.goal);
                    session.setCodexGoalState(normalizeCodexGoalState(goal));
                    lastGoalAnnouncementSignature = goalAnnouncementSignature(goal);
                    const message = formatGoal(goal, 'Codex goal set') ?? `Codex goal set:\n${objective}`;
                    sendCommandMessage(message);
                    emitReadyIfIdle({
                        pending,
                        queueSize: () => session.queue.size(),
                        shouldExit: this.shouldExit,
                        sendReady
                    });
                    return;
                }
            }

            if (command.kind === 'compact') {
                await appServerClient.compactThread({ threadId }, { signal: this.abortController.signal });
                turnInFlight = true;
                allowAnonymousTerminalEvent = true;
                return;
            }

            if (command.kind === 'review') {
                const reviewResponse = await appServerClient.startReview({
                    threadId,
                    target: command.target,
                    delivery: 'inline'
                }, { signal: this.abortController.signal });
                const reviewRecord = asRecord(reviewResponse);
                const turn = reviewRecord ? asRecord(reviewRecord.turn) : null;
                markCommandStarted(asString(turn?.id));
                return;
            }

            if (command.kind === 'undo') {
                await appServerClient.rollbackThread({ threadId, numTurns: command.numTurns });
                sendCommandMessage(`Rolled back the last ${command.numTurns} Codex turn${command.numTurns === 1 ? '' : 's'}. Local file changes are not reverted.`);
                emitReadyIfIdle({
                    pending,
                    queueSize: () => session.queue.size(),
                    shouldExit: this.shouldExit,
                    sendReady
                });
            }
        };

        clearReadyAfterTurnTimer = () => {
            if (!readyAfterTurnTimer) {
                return;
            }
            clearTimeout(readyAfterTurnTimer);
            readyAfterTurnTimer = null;
        };

        scheduleReadyAfterTurn = () => {
            clearReadyAfterTurnTimer?.();
            readyAfterTurnTimer = setTimeout(() => {
                readyAfterTurnTimer = null;
                emitReadyIfIdle({
                    pending,
                    queueSize: () => session.queue.size(),
                    shouldExit: this.shouldExit,
                    sendReady
                });
            }, 120);
            readyAfterTurnTimer.unref?.();
        };

        const markIdleAfterAbort = () => {
            turnInFlight = false;
            allowAnonymousTerminalEvent = false;
            clearReadyAfterTurnTimer?.();
            if (session.thinking) {
                session.onThinkingChange(false);
            }
            emitReadyIfIdle({
                pending,
                queueSize: () => session.queue.size(),
                shouldExit: this.shouldExit,
                sendReady
            });
        };

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(markIdleAfterAbort),
            onSwitch: () => this.handleSwitchRequest()
        });

        while (!this.shouldExit) {
            logActiveHandles('loop-top');
            let message: QueuedMessage | null = pending;
            pending = null;
            if (!message) {
                const waitSignal = this.abortController.signal;
                const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    if (waitSignal.aborted && !this.shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${this.shouldExit}`);
                    break;
                }
                message = batch;
            }

            if (!message) {
                break;
            }

            messageBuffer.addMessage(message.message, 'user');

            try {
                const expandedCustomCommand = await expandCodexCustomSlashCommand(message.message, session.path);
                if (expandedCustomCommand) {
                    logger.debug(`[Codex] Expanded custom slash command to prompt (${expandedCustomCommand.length} chars)`);
                    message = { ...message, message: expandedCustomCommand };
                } else {
                    const builtinCommand = parseCodexBuiltinSlashCommand(message.message);
                    if (builtinCommand) {
                        try {
                            await handleBuiltinSlashCommand(builtinCommand, message.mode);
                        } catch (commandError) {
                            const commandErrorMessage = commandError instanceof Error ? commandError.message : String(commandError);
                            logger.warn('[Codex] Slash command failed:', commandError);
                            sendCommandMessage(`Codex slash command failed: ${commandErrorMessage}`);
                            emitReadyIfIdle({
                                pending,
                                queueSize: () => session.queue.size(),
                                shouldExit: this.shouldExit,
                                sendReady
                            });
                        }
                        continue;
                    }
                }

                const threadId = await ensureThread(message.mode);
                if (!threadId) {
                    logger.debug('[Codex] Missing thread id; restarting app-server thread');
                    hasThread = false;
                    pending = message;
                    continue;
                }

                const turnParams = buildTurnStartParams({
                    threadId,
                    message: message.message,
                    cwd: session.path,
                    mode: {
                        ...message.mode,
                        model: session.getModel() ?? message.mode.model
                    },
                    cliOverrides: session.codexCliOverrides
                });
                turnInFlight = true;
                allowAnonymousTerminalEvent = false;
                const turnResponse = await appServerClient.startTurn(turnParams, {
                    signal: this.abortController.signal
                });
                const turnRecord = asRecord(turnResponse);
                const turn = turnRecord ? asRecord(turnRecord.turn) : null;
                const turnId = asString(turn?.id);
                if (turnId) {
                    this.currentTurnId = turnId;
                } else if (!this.currentTurnId) {
                    allowAnonymousTerminalEvent = true;
                }
            } catch (error) {
                logger.warn('Error in codex session:', describeErrorForLog(error));
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                turnInFlight = false;
                allowAnonymousTerminalEvent = false;
                this.currentTurnId = null;

                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                } else {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    this.currentTurnId = null;
                    this.currentThreadId = null;
                    hasThread = false;
                }
            } finally {
                if (!turnInFlight) {
                    permissionHandler.reset();
                    reasoningProcessor.abort();
                    diffProcessor.reset();
                    appServerEventConverter.reset();
                    if (session.thinking) {
                        session.onThinkingChange(false);
                    }
                    clearReadyAfterTurnTimer?.();
                    emitReadyIfIdle({
                        pending,
                        queueSize: () => session.queue.size(),
                        shouldExit: this.shouldExit,
                        sendReady
                    });
                }
                logActiveHandles('after-turn');
            }
        }
    }

    protected async cleanup(): Promise<void> {
        logger.debug('[codex-remote]: cleanup start');
        try {
            await this.appServerClient.disconnect();
        } catch (error) {
            logger.debug('[codex-remote]: Error disconnecting client', error);
        }

        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.happyServer) {
            this.happyServer.stop();
            this.happyServer = null;
        }

        this.permissionHandler?.reset();
        this.reasoningProcessor?.abort();
        this.diffProcessor?.reset();
        this.permissionHandler = null;
        this.reasoningProcessor = null;
        this.diffProcessor = null;

        logger.debug('[codex-remote]: cleanup done');
    }
}

export async function codexRemoteLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    const launcher = new CodexRemoteLauncher(session);
    return launcher.launch();
}
