import type { InfiniteData } from '@tanstack/react-query'
import { AGENT_MESSAGE_PAYLOAD_TYPE, isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'

export function makeClientSideId(prefix: string): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return `${prefix}-${crypto.randomUUID()}`
    }
    return `${prefix}-${Date.now()}-${Math.random()}`
}

export function isUserMessage(msg: DecryptedMessage): boolean {
    const content = msg.content
    if (content && typeof content === 'object' && 'role' in content) {
        return (content as { role: string }).role === 'user'
    }
    return false
}

function isOptimisticMessage(msg: DecryptedMessage): boolean {
    return Boolean(msg.localId && msg.id === msg.localId)
}

function compareMessages(a: DecryptedMessage, b: DecryptedMessage): number {
    const aSeq = typeof a.seq === 'number' ? a.seq : null
    const bSeq = typeof b.seq === 'number' ? b.seq : null

    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
        return aSeq - bSeq
    }

    if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt
    }
    return a.id.localeCompare(b.id)
}

function getString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

// Claude Code 的 JSONL 把一个 assistant message 的每个 content block(以及被
// streaming 拆开的同一段 text 的多个 chunk)各落成单独一行,共享同一个 Anthropic
// message.id。用 message.id + 内容指纹做 identity,使得:
//  - 同一个 chunk 的 null(CLI 实时推送)和 tw(JSONL 同步)两版内容一致 → 同 identity → 去重;
//  - 同一段 text 被拆开的不同 chunk / 同一 message 下的不同 block → 不同 identity → 各自保留。
function fingerprintText(text: string): string {
    if (text.length === 0) return '0'
    let hash = 5381
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
    }
    return `${text.length}:${(hash >>> 0).toString(36)}`
}

function getAssistantBlockKey(message: unknown): string | null {
    if (!isObject(message)) return null
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') {
        return `text:${fingerprintText(content)}`
    }
    if (!Array.isArray(content) || content.length === 0) return null
    // hapi 每个 DB 行对应 Claude Code JSONL 的一个 content block,这里只看第一个。
    const block = content[0]
    if (!isObject(block) || typeof block.type !== 'string') return null
    if (block.type === 'tool_use' && typeof block.id === 'string') {
        return `tool_use:${block.id}`
    }
    if (block.type === 'text' && typeof block.text === 'string') {
        return `text:${fingerprintText(block.text)}`
    }
    if (block.type === 'thinking') {
        const thinking = typeof block.thinking === 'string' ? block.thinking : ''
        const signature = typeof block.signature === 'string' ? block.signature : ''
        return `thinking:${fingerprintText(signature || thinking)}`
    }
    return `block:${block.type}`
}

function getAgentMessageIdentity(msg: DecryptedMessage): string | null {
    if (msg.localId) {
        return `local:${msg.localId}`
    }

    const record = unwrapRoleWrappedRecordEnvelope(msg.content)
    if (!record || record.role !== 'agent' || !isObject(record.content)) {
        return null
    }

    const content = record.content
    if (content.type === 'event') {
        const id = getString(content.id)
        return id ? `agent-event:${id}` : null
    }

    const data = isObject(content.data) ? content.data : null
    if (!data) {
        return null
    }

    if (content.type === 'output') {
        if (data.type === 'assistant' && isObject(data.message)) {
            const messageId = getString(data.message.id)
            if (messageId) {
                const blockKey = getAssistantBlockKey(data.message)
                return blockKey
                    ? `agent-output-message:${messageId}:${blockKey}`
                    : `agent-output-message:${messageId}`
            }
        }

        const uuid = getString(data.uuid)
        if (uuid) {
            return `agent-output:${uuid}`
        }

        if (data.type === 'summary') {
            const leafUuid = getString(data.leafUuid)
            const summary = getString(data.summary)
            if (leafUuid && summary) {
                return `agent-summary:${leafUuid}:${summary}`
            }
        }
        return null
    }

    if (content.type === AGENT_MESSAGE_PAYLOAD_TYPE) {
        const type = getString(data.type)
        const id = getString(data.id)
        if (type && id) {
            return `agent-generic:${type}:${id}`
        }

        if (type === 'tool-call') {
            const callId = getString(data.callId)
            return callId ? `agent-generic:tool-call:${callId}` : null
        }

        if (type === 'tool-call-result') {
            const callId = getString(data.callId)
            return callId ? `agent-generic:tool-call-result:${callId}` : null
        }
    }

    return null
}

function upsertByMessageIdentity(messages: DecryptedMessage[]): DecryptedMessage[] {
    const byId = new Map<string, DecryptedMessage>()
    const idByIdentity = new Map<string, string>()

    for (const msg of messages) {
        const identity = getAgentMessageIdentity(msg)
        const existingId = identity ? idByIdentity.get(identity) : undefined
        if (existingId && existingId !== msg.id) {
            byId.delete(existingId)
        }

        byId.set(msg.id, msg)
        if (identity) {
            idByIdentity.set(identity, msg.id)
        }
    }

    return Array.from(byId.values()).sort(compareMessages)
}

export function mergeMessages(existing: DecryptedMessage[], incoming: DecryptedMessage[]): DecryptedMessage[] {
    let merged = upsertByMessageIdentity([...existing, ...incoming])

    const incomingStoredLocalIds = new Set<string>()
    for (const msg of incoming) {
        if (msg.localId && !isOptimisticMessage(msg)) {
            incomingStoredLocalIds.add(msg.localId)
        }
    }

    // If we received stored messages with a localId, drop any optimistic bubbles with the same localId.
    if (incomingStoredLocalIds.size > 0) {
        merged = merged.filter((msg) => {
            if (!msg.localId || !incomingStoredLocalIds.has(msg.localId)) {
                return true
            }
            return !isOptimisticMessage(msg)
        })
    }

    // Fallback: if an optimistic message was marked as sent but we didn't get a localId echo,
    // drop it when a server user message appears close in time.
    const optimisticMessages = merged.filter((m) => isOptimisticMessage(m))
    const nonOptimisticMessages = merged.filter((m) => !isOptimisticMessage(m))
    const result: DecryptedMessage[] = [...nonOptimisticMessages]

    for (const optimistic of optimisticMessages) {
        if (optimistic.status === 'sent') {
            const hasServerUserMessage = nonOptimisticMessages.some((m) =>
                isUserMessage(m) &&
                Math.abs(m.createdAt - optimistic.createdAt) < 10_000
            )
            if (hasServerUserMessage) {
                continue
            }
        }
        result.push(optimistic)
    }

    result.sort(compareMessages)
    return result
}

export function upsertMessagesInCache(
    data: InfiniteData<MessagesResponse> | undefined,
    incoming: DecryptedMessage[],
): InfiniteData<MessagesResponse> {
    const mergedIncoming = mergeMessages([], incoming)

    if (!data || data.pages.length === 0) {
        return {
            pages: [
                {
                    messages: mergedIncoming,
                    page: {
                        limit: 50,
                        beforeSeq: null,
                        nextBeforeSeq: null,
                        hasMore: false,
                    },
                },
            ],
            pageParams: [null],
        }
    }

    const pages = data.pages.slice()
    const first = pages[0]
    pages[0] = {
        ...first,
        messages: mergeMessages(first.messages, mergedIncoming),
    }

    return {
        ...data,
        pages,
    }
}
