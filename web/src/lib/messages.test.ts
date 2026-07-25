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
