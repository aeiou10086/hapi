import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { coalesceAgentMessages, mergeMessages } from './messages'
import type { NormalizedMessage } from '@/chat/types'

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

    it('keeps separate text chunks that share an Anthropic message id (streaming-split text)', () => {
        const chunkA = msg('db-1', 1, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'uuid-a',
                    message: {
                        id: 'msg_shared',
                        role: 'assistant',
                        content: [{ type: 'text', text: '前面一段文本' }]
                    }
                }
            }
        })
        const chunkB = msg('db-2', 2, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'uuid-b',
                    message: {
                        id: 'msg_shared',
                        role: 'assistant',
                        content: [{ type: 'text', text: '后面一段文本' }]
                    }
                }
            }
        })

        // Claude Code 把同一段长 text 按 streaming chunk 拆成多行(共享 message.id),
        // 这两行内容不同,必须各自保留,否则 web 只会显示末尾那段。
        expect(mergeMessages([], [chunkA, chunkB])).toEqual([chunkA, chunkB])
    })

    it('dedupes identical text chunk across CLI and JSONL copies sharing message id', () => {
        const cliCopy = msg('db-1', 1, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'hapi-random',
                    message: {
                        id: 'msg_shared',
                        role: 'assistant',
                        content: [{ type: 'text', text: '完全相同的一段文本' }]
                    }
                }
            }
        })
        const jsonlCopy = msg('db-2', 2, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'jsonl-uuid',
                    message: {
                        id: 'msg_shared',
                        role: 'assistant',
                        content: [{ type: 'text', text: '完全相同的一段文本' }]
                    }
                }
            }
        })

        // 同一个 chunk 的 null(CLI 实时推)和 tw(JSONL 同步)两版内容一致,只留一条。
        expect(mergeMessages([], [cliCopy, jsonlCopy])).toEqual([jsonlCopy])
    })
})

describe('coalesceAgentMessages', () => {
    function agentMsg(id: string, mid: string, content: unknown, seq: number): NormalizedMessage {
        return {
            id,
            localId: null,
            createdAt: seq,
            role: 'agent',
            isSidechain: false,
            content: content as NormalizedMessage['content'],
            messageId: mid,
        }
    }

    it('joins text chunks split across tool_use by streaming, ordering text before the tool call', () => {
        // Claude Code JSONL 落盘顺序: text前半, tool_use, text后半 —— 共享同一个 Anthropic message.id。
        const chunks: NormalizedMessage[] = [
            agentMsg('a', 'msg_shared', [{ type: 'text', text: '前半(', uuid: 'a', parentUUID: null }], 1),
            agentMsg('b', 'msg_shared', [{ type: 'tool-call', id: 'tu1', name: 'Read', input: {}, description: null, uuid: 'b', parentUUID: null }], 2),
            agentMsg('c', 'msg_shared', [{ type: 'text', text: '后半)', uuid: 'c', parentUUID: null }], 3),
        ]

        const result = coalesceAgentMessages(chunks)

        expect(result).toHaveLength(1)
        const content = result[0].content as Array<{ type: string; text?: string; name?: string }>
        expect(content[0]).toMatchObject({ type: 'text', text: '前半(后半)' })
        expect(content[1]).toMatchObject({ type: 'tool-call', name: 'Read' })
    })

    it('leaves messages without a shared message id untouched', () => {
        const a = agentMsg('a', '', [{ type: 'text', text: 'hi', uuid: 'a', parentUUID: null }], 1)
        const b = agentMsg('b', '', [{ type: 'text', text: 'yo', uuid: 'b', parentUUID: null }], 2)

        const result = coalesceAgentMessages([a, b])

        expect(result).toHaveLength(2)
    })
})
