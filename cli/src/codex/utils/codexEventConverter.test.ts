import { describe, expect, it } from 'vitest';
import { convertCodexEvent } from './codexEventConverter';

describe('convertCodexEvent', () => {
    it('extracts session_meta id', () => {
        const result = convertCodexEvent({
            type: 'session_meta',
            payload: { id: 'session-123' }
        });

        expect(result).toEqual({ sessionId: 'session-123' });
    });

    it('converts agent_message events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'hello' }
        });

        expect(result?.message).toMatchObject({
            type: 'message',
            message: 'hello'
        });
    });

    it('converts user_message events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'hello user' }
        });

        expect(result?.userMessage).toBe('hello user');
    });

    it('converts reasoning events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_reasoning', text: 'thinking' }
        });

        expect(result?.message).toMatchObject({
            type: 'reasoning',
            message: 'thinking'
        });
    });

    it('converts reasoning delta events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_reasoning_delta', delta: 'step' }
        });

        expect(result?.message).toEqual({
            type: 'reasoning-delta',
            delta: 'step'
        });
    });

    it('converts function_call items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: 'ToolName',
                call_id: 'call-1',
                arguments: '{"foo":"bar"}'
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call',
            name: 'ToolName',
            callId: 'call-1',
            input: { foo: 'bar' }
        });
    });

    it('preserves exec_command arguments as tool input', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: 'exec_command',
                call_id: 'call-exec',
                arguments: '{"cmd":"uv run pytest tests/qsystem/test_plan.py -q","workdir":"/tmp/project"}'
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call',
            name: 'exec_command',
            callId: 'call-exec',
            input: {
                cmd: 'uv run pytest tests/qsystem/test_plan.py -q',
                workdir: '/tmp/project'
            }
        });
    });

    it('converts function_call_output items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call_output',
                call_id: 'call-2',
                output: { ok: true }
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call-result',
            callId: 'call-2',
            output: { ok: true }
        });
    });

    it('converts apply_patch custom_tool_call items into CodexPatch tool calls', () => {
        const patch = '*** Begin Patch\n*** Update File: src/foo.ts\n@@\n+test\n*** End Patch\n';
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'custom_tool_call',
                name: 'apply_patch',
                call_id: 'call-patch',
                input: patch
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call',
            name: 'CodexPatch',
            callId: 'call-patch',
            input: {
                changes: {
                    'src/foo.ts': {
                        path: 'src/foo.ts',
                        kind: 'update',
                        diff: patch
                    }
                }
            }
        });
    });

    it('converts custom_tool_call_output items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'custom_tool_call_output',
                call_id: 'call-patch',
                output: 'Success. Updated files.'
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call-result',
            callId: 'call-patch',
            output: 'Success. Updated files.'
        });
    });
});
