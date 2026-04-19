/**
 * JSONL Backfill: reads Claude Code transcript files and inserts missing
 * messages into hapi's SQLite database. This covers the gap when the CLI
 * process disconnects but the claude process keeps running and writing to
 * the JSONL file.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Store } from '../store'

// Types we skip during backfill (internal Claude Code events)
const SKIP_TYPES = new Set([
    'queue-operation',
    'file-history-snapshot',
    'change',
    'attachment',
])

// Track last backfill time per session to avoid redundant work
const lastBackfillAt = new Map<string, number>()
const BACKFILL_COOLDOWN_MS = 30_000 // 30 seconds

/**
 * Find the JSONL transcript file for a given Claude session ID.
 * Searches ~/.claude/projects/\*\/{claudeSessionId}.jsonl
 */
function findTranscriptPath(claudeSessionId: string): string | null {
    const home = homedir()
    const projectsDir = join(home, '.claude', 'projects')

    if (!existsSync(projectsDir)) {
        return null
    }

    try {
        const dirs = readdirSync(projectsDir, { withFileTypes: true })
        for (const dir of dirs) {
            if (!dir.isDirectory()) continue
            const candidate = join(projectsDir, dir.name, `${claudeSessionId}.jsonl`)
            if (existsSync(candidate)) {
                return candidate
            }
        }
    } catch {
        // ignore
    }

    return null
}

/**
 * Parse a JSONL file and return valid entries with their UUIDs.
 */
function parseTranscript(filePath: string): Array<{ uuid: string; entry: unknown; timestamp: string }> {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    const results: Array<{ uuid: string; entry: unknown; timestamp: string }> = []

    for (const line of lines) {
        if (!line.trim()) continue

        try {
            const parsed = JSON.parse(line)

            // Skip internal event types
            if (SKIP_TYPES.has(parsed.type)) continue

            // Must have a uuid for deduplication
            const uuid = parsed.uuid
            if (!uuid) continue

            const timestamp = parsed.timestamp || ''

            results.push({ uuid, entry: parsed, timestamp })
        } catch {
            // Skip malformed lines
        }
    }

    return results
}

/**
 * Backfill missing messages from a Claude JSONL transcript into hapi's database.
 *
 * @returns Number of messages inserted
 */
export function backfillFromTranscript(
    store: Store,
    hapiSessionId: string,
    claudeSessionId: string,
): number {
    // Cooldown check
    const now = Date.now()
    const lastAt = lastBackfillAt.get(hapiSessionId) ?? 0
    if (now - lastAt < BACKFILL_COOLDOWN_MS) {
        return 0
    }
    lastBackfillAt.set(hapiSessionId, now)

    // Find transcript file
    const transcriptPath = findTranscriptPath(claudeSessionId)
    if (!transcriptPath) {
        return 0
    }

    // Check if file has been modified since last stored message
    const stat = statSync(transcriptPath)
    const lastMessage = store.messages.getMessages(hapiSessionId, 1)
    if (lastMessage.length > 0 && stat.mtimeMs <= lastMessage[0].createdAt) {
        return 0 // File hasn't changed since last message
    }

    // Parse transcript
    const entries = parseTranscript(transcriptPath)
    if (entries.length === 0) {
        return 0
    }

    // Insert missing messages (localId-based deduplication handles duplicates)
    let inserted = 0
    for (const { uuid, entry } of entries) {
        const localId = `backfill:${uuid}`

        // Wrap in the same envelope format the CLI uses
        const content = {
            role: 'agent',
            content: {
                type: 'output',
                data: entry,
            },
        }

        const before = store.messages.getMessages(hapiSessionId, 1)
        const msg = store.messages.addMessage(hapiSessionId, content, localId)

        // Check if it was actually inserted (not a duplicate)
        const after = store.messages.getMessages(hapiSessionId, 1)
        if (after.length > 0 && (before.length === 0 || after[0].id !== before[0].id)) {
            inserted++
        }
    }

    return inserted
}
