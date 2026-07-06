import { describe, expect, it } from 'vitest'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { normalizeAgentRecord } from '@/chat/normalizeAgent'

describe('normalizeAgentRecord', () => {
    it('preserves generic tool-call-result error state', () => {
        const message = normalizeAgentRecord(
            'msg-1',
            null,
            1_700_000_000_000,
            {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'tool-call-result',
                    callId: 'call-1',
                    output: 'failed',
                    is_error: true
                }
            }
        )

        expect(message).toMatchObject({
            role: 'agent',
            content: [{
                type: 'tool-result',
                tool_use_id: 'call-1',
                content: 'failed',
                is_error: true
            }]
        })
    })
})
