import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logger } from '@/ui/logger';

const CodexSessionEventSchema = z.object({
    timestamp: z.string().optional(),
    type: z.string(),
    payload: z.unknown().optional()
});

export type CodexSessionEvent = z.infer<typeof CodexSessionEventSchema>;

export type CodexMessage = {
    type: 'message';
    message: string;
    id: string;
} | {
    type: 'reasoning';
    message: string;
    id: string;
} | {
    type: 'reasoning-delta';
    delta: string;
} | {
    type: 'token_count';
    info: Record<string, unknown>;
    id: string;
} | {
    type: 'tool-call';
    name: string;
    callId: string;
    input: unknown;
    id: string;
} | {
    type: 'tool-call-result';
    callId: string;
    output: unknown;
    id: string;
};

export type CodexConversionResult = {
    sessionId?: string;
    message?: CodexMessage;
    userMessage?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseArguments(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            logger.debug('[codexEventConverter] Failed to parse function_call arguments as JSON:', error);
        }
    }

    return value;
}

function extractCallId(payload: Record<string, unknown>): string | null {
    const candidates = [
        'call_id',
        'callId',
        'tool_call_id',
        'toolCallId',
        'id'
    ];

    for (const key of candidates) {
        const value = payload[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }

    return null;
}

function normalizeCustomToolInput(payload: Record<string, unknown>): unknown {
    if (Object.prototype.hasOwnProperty.call(payload, 'input')) {
        return { input: payload.input };
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'arguments')) {
        return parseArguments(payload.arguments);
    }
    return {};
}

function extractApplyPatchChanges(patch: string): Record<string, unknown> {
    const lines = patch.split('\n');
    const headers: Array<{
        lineIndex: number;
        kind: 'add' | 'update' | 'delete' | 'move';
        path: string;
        oldPath?: string;
    }> = [];

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const fileMatch = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
        if (fileMatch) {
            headers.push({
                lineIndex: index,
                kind: fileMatch[1].toLowerCase() as 'add' | 'update' | 'delete',
                path: fileMatch[2].trim()
            });
            continue;
        }

        const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
        const previousHeader = headers.at(-1);
        if (moveMatch && previousHeader) {
            previousHeader.oldPath = previousHeader.path;
            previousHeader.path = moveMatch[1].trim();
            previousHeader.kind = 'move';
        }
    }

    const changes: Record<string, unknown> = {};
    for (let index = 0; index < headers.length; index++) {
        const header = headers[index];
        const nextHeader = headers[index + 1];
        const start = Math.max(0, header.lineIndex - 1);
        const end = nextHeader ? Math.max(start + 1, nextHeader.lineIndex - 1) : lines.length;
        changes[header.path] = {
            path: header.path,
            kind: header.kind,
            diff: lines.slice(start, end).join('\n'),
            ...(header.oldPath ? { oldPath: header.oldPath } : {})
        };
    }

    return changes;
}

function normalizeCustomTool(name: string, payload: Record<string, unknown>): { name: string; input: unknown } {
    if (name === 'apply_patch' && typeof payload.input === 'string') {
        return {
            name: 'CodexPatch',
            input: {
                changes: extractApplyPatchChanges(payload.input)
            }
        };
    }

    return {
        name,
        input: normalizeCustomToolInput(payload)
    };
}

export function convertCodexEvent(rawEvent: unknown): CodexConversionResult | null {
    const parsed = CodexSessionEventSchema.safeParse(rawEvent);
    if (!parsed.success) {
        return null;
    }

    const { type, payload } = parsed.data;
    const payloadRecord = asRecord(payload);

    if (type === 'session_meta') {
        const sessionId = payloadRecord ? asString(payloadRecord.id) : null;
        if (!sessionId) {
            return null;
        }
        return { sessionId };
    }

    if (!payloadRecord) {
        return null;
    }

    if (type === 'event_msg') {
        const eventType = asString(payloadRecord.type);
        if (!eventType) {
            return null;
        }

        if (eventType === 'user_message') {
            const message = asString(payloadRecord.message)
                ?? asString(payloadRecord.text)
                ?? asString(payloadRecord.content);
            if (!message) {
                return null;
            }
            return {
                userMessage: message
            };
        }

        if (eventType === 'agent_message') {
            const message = asString(payloadRecord.message);
            if (!message) {
                return null;
            }
            return {
                message: {
                    type: 'message',
                    message,
                    id: randomUUID()
                }
            };
        }

        if (eventType === 'agent_reasoning') {
            const message = asString(payloadRecord.text) ?? asString(payloadRecord.message);
            if (!message) {
                return null;
            }
            return {
                message: {
                    type: 'reasoning',
                    message,
                    id: randomUUID()
                }
            };
        }

        if (eventType === 'agent_reasoning_delta') {
            const delta = asString(payloadRecord.delta) ?? asString(payloadRecord.text) ?? asString(payloadRecord.message);
            if (!delta) {
                return null;
            }
            return {
                message: {
                    type: 'reasoning-delta',
                    delta
                }
            };
        }

        if (eventType === 'token_count') {
            const info = asRecord(payloadRecord.info);
            if (!info) {
                return null;
            }
            return {
                message: {
                    type: 'token_count',
                    info,
                    id: randomUUID()
                }
            };
        }

        return null;
    }

    if (type === 'response_item') {
        const itemType = asString(payloadRecord.type);
        if (!itemType) {
            return null;
        }

        if (itemType === 'function_call') {
            const name = asString(payloadRecord.name);
            const callId = extractCallId(payloadRecord);
            if (!name || !callId) {
                return null;
            }
            return {
                message: {
                    type: 'tool-call',
                    name,
                    callId,
                    input: parseArguments(payloadRecord.arguments),
                    id: randomUUID()
                }
            };
        }

        if (itemType === 'custom_tool_call') {
            const name = asString(payloadRecord.name);
            const callId = extractCallId(payloadRecord);
            if (!name || !callId) {
                return null;
            }
            const tool = normalizeCustomTool(name, payloadRecord);
            return {
                message: {
                    type: 'tool-call',
                    name: tool.name,
                    callId,
                    input: tool.input,
                    id: randomUUID()
                }
            };
        }

        if (itemType === 'function_call_output') {
            const callId = extractCallId(payloadRecord);
            if (!callId) {
                return null;
            }
            return {
                message: {
                    type: 'tool-call-result',
                    callId,
                    output: payloadRecord.output,
                    id: randomUUID()
                }
            };
        }

        if (itemType === 'custom_tool_call_output') {
            const callId = extractCallId(payloadRecord);
            if (!callId) {
                return null;
            }
            return {
                message: {
                    type: 'tool-call-result',
                    callId,
                    output: payloadRecord.output,
                    id: randomUUID()
                }
            };
        }

        return null;
    }

    return null;
}
