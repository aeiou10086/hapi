import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { mergeMessages } from './messages'

function msg(id: string, seq: number, content: unknown): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        createdAt: seq,
        content,
    }
}

describe('mergeMessages', () => {
    it('dedupes stored Claude agent outputs by transcript uuid even when DB ids differ', () => {
        const first = msg('db-1', 1, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'claude-message-1',
                    message: { role: 'assistant', content: 'hello' }
                }
            }
        })
        const duplicate = msg('db-2', 2, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'claude-message-1',
                    message: { role: 'assistant', content: 'hello' }
                }
            }
        })

        expect(mergeMessages([], [first, duplicate])).toEqual([duplicate])
    })

    it('dedupes Claude assistant outputs by API message id when transcript uuids differ', () => {
        const first = msg('db-1', 1, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'streaming-jsonl-entry',
                    message: {
                        id: 'msg_vrtx_123',
                        role: 'assistant',
                        content: 'hello'
                    }
                }
            }
        })
        const duplicate = msg('db-2', 2, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'completed-jsonl-entry',
                    message: {
                        id: 'msg_vrtx_123',
                        role: 'assistant',
                        content: 'hello'
                    }
                }
            }
        })

        expect(mergeMessages([], [first, duplicate])).toEqual([duplicate])
    })

    it('dedupes generic agent outputs by payload id', () => {
        const first = msg('db-1', 1, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', id: 'agent-output-1', message: 'hello' }
            }
        })
        const duplicate = msg('db-2', 2, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', id: 'agent-output-1', message: 'hello' }
            }
        })

        expect(mergeMessages([first], [duplicate])).toEqual([duplicate])
    })

    it('keeps separate agent text messages when no stable payload id exists', () => {
        const first = msg('db-1', 1, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: 'same text' }
            }
        })
        const second = msg('db-2', 2, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: 'same text' }
            }
        })

        expect(mergeMessages([], [first, second])).toEqual([first, second])
    })
})
