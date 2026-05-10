/**
 * TranscriptWatcher: monitors Claude Code JSONL transcript files on the hub side.
 * When the CLI disconnects but the claude process keeps running, this watcher
 * ensures new messages are still synced to the database.
 *
 * Uses fs.watch + periodic polling as fallback.
 */

import { readFileSync, existsSync, readdirSync, watch, type FSWatcher, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Store } from '../store'
import type { EventPublisher } from './eventPublisher'

// JSONL types to skip (internal Claude Code events)
const SKIP_TYPES = new Set([
    'queue-operation',
    'file-history-snapshot',
    'change',
    'attachment',
    'last-prompt',
    'rate_limit_event',
])

// System subtypes that should be visible
const VISIBLE_SYSTEM_SUBTYPES = new Set([
    'api_error',
    'turn_duration',
    'microcompact_boundary',
    'compact_boundary',
])

// Prefixes that indicate system-injected user messages (not real user input)
const SYSTEM_INJECTION_PREFIXES = [
    '<task-notification>',
    '<command-name>',
    '<local-command-caveat>',
    '<system-reminder>',
]

const POLL_INTERVAL_MS = 5_000

type WatcherState = {
    filePath: string
    cursor: number // line number, 0-indexed
    fsWatcher: FSWatcher | null
    pollTimer: NodeJS.Timeout
    processedKeys: Set<string>
}

export class TranscriptWatcher {
    private readonly store: Store
    private readonly publisher: EventPublisher
    private readonly watchers = new Map<string, WatcherState>()

    constructor(store: Store, publisher: EventPublisher) {
        this.store = store
        this.publisher = publisher
    }

    /**
     * Start watching a session's JSONL file.
     * Initial cursor = current end of file (skip existing content).
     */
    watchSession(hapiSessionId: string, claudeSessionId: string): void {
        if (this.watchers.has(hapiSessionId)) {
            return // Already watching
        }

        const filePath = this.findTranscriptPath(claudeSessionId)
        if (!filePath) {
            return
        }

        // Count current lines to set initial cursor
        const initialCursor = this.countLines(filePath)

        // Seed processed keys from current file content (for dedup during overlap)
        const processedKeys = new Set<string>()
        try {
            const lines = readFileSync(filePath, 'utf-8').split('\n')
            for (const line of lines) {
                if (!line.trim()) continue
                try {
                    const parsed = JSON.parse(line)
                    const key = this.messageKey(parsed)
                    if (key) processedKeys.add(key)
                } catch { /* skip */ }
            }
        } catch { /* skip */ }

        // Set up fs.watch
        let fsWatcher: FSWatcher | null = null
        try {
            fsWatcher = watch(filePath, () => {
                this.onFileChange(hapiSessionId)
            })
        } catch {
            // fs.watch may fail on some systems; polling is the fallback
        }

        // Set up polling fallback
        const pollTimer = setInterval(() => {
            this.onFileChange(hapiSessionId)
        }, POLL_INTERVAL_MS)

        this.watchers.set(hapiSessionId, {
            filePath,
            cursor: initialCursor,
            fsWatcher,
            pollTimer,
            processedKeys,
        })

        console.log(`[transcript-watcher] watching session=${hapiSessionId} file=${filePath} cursor=${initialCursor}`)
    }

    /**
     * Stop watching a session.
     */
    unwatchSession(hapiSessionId: string): void {
        const state = this.watchers.get(hapiSessionId)
        if (!state) return

        state.fsWatcher?.close()
        clearInterval(state.pollTimer)
        this.watchers.delete(hapiSessionId)
    }

    /**
     * Stop all watchers.
     */
    stopAll(): void {
        for (const [id] of this.watchers) {
            this.unwatchSession(id)
        }
    }

    /**
     * Check if a session is being watched.
     */
    isWatching(hapiSessionId: string): boolean {
        return this.watchers.has(hapiSessionId)
    }

    /**
     * Handle file change: read new lines from cursor, parse, insert.
     */
    private onFileChange(hapiSessionId: string): void {
        const state = this.watchers.get(hapiSessionId)
        if (!state) return

        if (!existsSync(state.filePath)) return

        let lines: string[]
        try {
            const content = readFileSync(state.filePath, 'utf-8')
            lines = content.split('\n')
        } catch {
            return
        }

        // Handle file truncation (cursor beyond file length)
        if (state.cursor > lines.length) {
            state.cursor = 0
            state.processedKeys.clear()
        }

        // No new lines
        if (state.cursor >= lines.length) return

        const newLines = lines.slice(state.cursor)
        state.cursor = lines.length

        let inserted = 0
        for (const line of newLines) {
            if (!line.trim()) continue

            let parsed: Record<string, unknown>
            try {
                parsed = JSON.parse(line)
            } catch {
                continue
            }

            // Skip internal types
            if (SKIP_TYPES.has(parsed.type as string)) continue

            // Skip user messages: they always originate from web/hub flow and
            // are already persisted in the DB at send time. Re-inserting them
            // here writes a duplicate row with a different localId ("tw:<uuid>"
            // instead of the web's localId), giving it a new seq. Then on the
            // next CLI reconnect, backfillMessages picks up that new seq and
            // re-feeds the message to the SDK — causing the message to be
            // executed twice every time the hub restarts.
            if (parsed.type === 'user') continue

            // Skip system messages unless visible subtype
            if (parsed.type === 'system') {
                if (!VISIBLE_SYSTEM_SUBTYPES.has(parsed.subtype as string)) continue
            }

            // Skip meta and compact summary messages
            if (parsed.isMeta === true || parsed.isCompactSummary === true) continue

            // Skip sidechain messages
            if (parsed.isSidechain === true) continue

            // Dedup by message key
            const key = this.messageKey(parsed)
            if (!key) continue
            if (state.processedKeys.has(key)) continue
            state.processedKeys.add(key)

            // Build message content matching CLI format
            const content = this.buildMessageContent(parsed)
            const localId = `tw:${key}`

            try {
                this.store.messages.addMessage(hapiSessionId, content, localId)
                inserted++
            } catch {
                // Duplicate localId or other DB error — skip
            }
        }

        if (inserted > 0) {
            console.log(`[transcript-watcher] inserted ${inserted} messages for session=${hapiSessionId}`)
            this.publisher.emit({
                type: 'session-updated',
                sessionId: hapiSessionId,
                data: { sid: hapiSessionId },
            })
        }
    }

    /**
     * Build message content in the same format as CLI's sendClaudeSessionMessage.
     */
    private buildMessageContent(entry: Record<string, unknown>): unknown {
        // Detect external user messages (same logic as CLI's isExternalUserMessage)
        if (entry.type === 'user') {
            const message = entry.message as Record<string, unknown> | undefined
            if (message && typeof message.content === 'string') {
                const trimmed = (message.content as string).trimStart()
                const isSystemInjection = SYSTEM_INJECTION_PREFIXES.some(p => trimmed.startsWith(p))
                if (!isSystemInjection) {
                    return {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: message.content,
                        },
                        meta: { sentFrom: 'transcript-watcher' },
                    }
                }
            }
        }

        // Everything else → agent output envelope
        return {
            role: 'agent',
            content: {
                type: 'output',
                data: entry,
            },
            meta: { sentFrom: 'transcript-watcher' },
        }
    }

    /**
     * Generate a unique key for a JSONL entry (same as CLI's messageKey).
     */
    private messageKey(entry: Record<string, unknown>): string | null {
        if (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system') {
            return entry.uuid as string ?? null
        }
        if (entry.type === 'summary') {
            return `summary:${entry.leafUuid}:${entry.summary}`
        }
        return entry.uuid as string ?? null
    }

    /**
     * Find the JSONL transcript file for a Claude session ID.
     */
    private findTranscriptPath(claudeSessionId: string): string | null {
        const home = homedir()
        const projectsDir = join(home, '.claude', 'projects')
        if (!existsSync(projectsDir)) return null

        try {
            const dirs = readdirSync(projectsDir, { withFileTypes: true })
            for (const dir of dirs) {
                if (!dir.isDirectory()) continue
                const candidate = join(projectsDir, dir.name, `${claudeSessionId}.jsonl`)
                if (existsSync(candidate)) return candidate
            }
        } catch { /* ignore */ }

        return null
    }

    /**
     * Count lines in a file.
     */
    private countLines(filePath: string): number {
        try {
            const content = readFileSync(filePath, 'utf-8')
            return content.split('\n').length
        } catch {
            return 0
        }
    }
}
