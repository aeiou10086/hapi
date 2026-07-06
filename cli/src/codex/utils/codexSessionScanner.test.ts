import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createCodexSessionScanner } from './codexSessionScanner';
import type { CodexSessionEvent } from './codexEventConverter';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('codexSessionScanner', () => {
    let testDir: string;
    let sessionsDir: string;
    let sessionFile: string;
    let originalCodexHome: string | undefined;
    let scanner: Awaited<ReturnType<typeof createCodexSessionScanner>> | null = null;
    let events: CodexSessionEvent[] = [];

    beforeEach(async () => {
        testDir = join(tmpdir(), `codex-scanner-${Date.now()}`);
        sessionsDir = join(testDir, 'sessions', '2025', '12', '22');
        await mkdir(sessionsDir, { recursive: true });

        originalCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = testDir;

        events = [];
    });

    afterEach(async () => {
        if (scanner) {
            await scanner.cleanup();
            scanner = null;
        }

        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = originalCodexHome;
        }

        if (existsSync(testDir)) {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('emits only new events after startup', async () => {
        const sessionId = 'session-123';
        sessionFile = join(sessionsDir, `codex-${sessionId}.jsonl`);

        const initialLines = [
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } })
        ];

        await writeFile(sessionFile, initialLines.join('\n') + '\n');

        scanner = await createCodexSessionScanner({
            sessionId,
            onEvent: (event) => events.push(event)
        });

        await wait(150);
        expect(events).toHaveLength(0);

        const newLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-1', arguments: '{}' }
        });
        await appendFile(sessionFile, newLine + '\n');

        await wait(200);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('response_item');
    });

    it('limits session scan to dates within the start window', async () => {
        const referenceTimestampMs = Date.parse('2025-12-22T00:00:00.000Z');
        const windowMs = 2 * 60 * 1000;
        const matchingSessionId = 'session-222';
        const outsideSessionId = 'session-999';
        const outsideDir = join(testDir, 'sessions', '2025', '12', '20');
        const matchingFile = join(sessionsDir, `codex-${matchingSessionId}.jsonl`);
        const outsideFile = join(outsideDir, `codex-${outsideSessionId}.jsonl`);

        await mkdir(outsideDir, { recursive: true });
        const baseLines = [
            JSON.stringify({ type: 'session_meta', payload: { id: matchingSessionId, cwd: '/data/github/happy/hapi', timestamp: '2025-12-22T00:00:30.000Z' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } })
        ];
        await writeFile(matchingFile, baseLines.join('\n') + '\n');
        await writeFile(
            outsideFile,
            JSON.stringify({ type: 'session_meta', payload: { id: outsideSessionId, cwd: '/data/github/happy/hapi', timestamp: '2025-12-20T00:00:00.000Z' } }) + '\n'
        );

        scanner = await createCodexSessionScanner({
            sessionId: null,
            cwd: '/data/github/happy/hapi',
            startupTimestampMs: referenceTimestampMs,
            sessionStartWindowMs: windowMs,
            onEvent: (event) => events.push(event)
        });

        await wait(200);
        expect(events).toHaveLength(0);

        const newLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-2', arguments: '{}' }
        });
        await appendFile(matchingFile, newLine + '\n');

        await wait(200);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('response_item');
    });

    it('fails fast when cwd is missing and no sessionId is provided', async () => {
        const sessionId = 'session-missing-cwd';
        const matchFailedMessage = 'No cwd provided for Codex session matching; refusing to fallback.';
        sessionFile = join(sessionsDir, `codex-${sessionId}.jsonl`);

        await writeFile(
            sessionFile,
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }) + '\n'
        );

        let failureMessage: string | null = null;
        scanner = await createCodexSessionScanner({
            sessionId: null,
            onEvent: (event) => events.push(event),
            onSessionMatchFailed: (message) => {
                failureMessage = message;
            }
        });

        await wait(150);
        expect(failureMessage).toBe(matchFailedMessage);
        expect(events).toHaveLength(0);

        const newLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-3', arguments: '{}' }
        });
        await appendFile(sessionFile, newLine + '\n');

        await wait(200);
        expect(events).toHaveLength(0);
    });

    it('adopts a reused older session file when fresh matching activity appears after startup', async () => {
        const reusedSessionId = 'session-reused-old-file';
        const targetCwd = '/data/github/happy/hapi';
        const startupTimestampMs = Date.now();
        const now = new Date(startupTimestampMs);
        const currentSessionsDir = join(
            testDir,
            'sessions',
            String(now.getFullYear()),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0')
        );
        await mkdir(currentSessionsDir, { recursive: true });
        sessionFile = join(currentSessionsDir, `codex-${reusedSessionId}.jsonl`);

        await writeFile(
            sessionFile,
            JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: reusedSessionId,
                    cwd: targetCwd,
                    timestamp: new Date(startupTimestampMs - 10 * 60 * 1000).toISOString()
                }
            }) + '\n'
        );

        let matchedSessionId: string | null = null;
        scanner = await createCodexSessionScanner({
            sessionId: null,
            cwd: targetCwd,
            startupTimestampMs,
            onEvent: (event) => events.push(event),
            onSessionFound: (sessionId) => {
                matchedSessionId = sessionId;
            }
        });

        await wait(150);
        expect(events).toHaveLength(0);
        expect(matchedSessionId).toBeNull();

        const newLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-reused', arguments: '{}' }
        });
        await appendFile(sessionFile, newLine + '\n');

        await wait(2300);
        expect(matchedSessionId).toBe(reusedSessionId);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('response_item');
    });

    it('adopts a reused older session file from an old date directory when fresh matching activity appears after startup', async () => {
        const reusedSessionId = 'session-reused-old-date-file';
        const targetCwd = '/data/github/happy/hapi';
        const startupTimestampMs = Date.now();
        const oldSessionsDir = join(testDir, 'sessions', '2025', '11', '10');
        await mkdir(oldSessionsDir, { recursive: true });
        sessionFile = join(oldSessionsDir, `codex-${reusedSessionId}.jsonl`);

        await writeFile(
            sessionFile,
            JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: reusedSessionId,
                    cwd: targetCwd,
                    timestamp: new Date(startupTimestampMs - 10 * 60 * 1000).toISOString()
                }
            }) + '\n' +
            JSON.stringify({
                type: 'event_msg',
                payload: { type: 'user_message', message: 'historical user message' }
            }) + '\n' +
            JSON.stringify({
                type: 'event_msg',
                payload: { type: 'agent_message', message: 'historical agent message' }
            }) + '\n'
        );

        let matchedSessionId: string | null = null;
        scanner = await createCodexSessionScanner({
            sessionId: null,
            cwd: targetCwd,
            startupTimestampMs,
            onEvent: (event) => events.push(event),
            onSessionFound: (sessionId) => {
                matchedSessionId = sessionId;
            }
        });

        await wait(150);
        expect(events).toHaveLength(0);
        expect(matchedSessionId).toBeNull();

        const newLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-reused-old-date', arguments: '{}' }
        });
        await appendFile(sessionFile, newLine + '\n');

        await wait(2300);
        expect(matchedSessionId).toBe(reusedSessionId);
        expect(events.map((event) => event.type)).toEqual([
            'event_msg',
            'event_msg',
            'response_item'
        ]);
        expect(events[0].payload).toMatchObject({ message: 'historical user message' });
        expect(events[1].payload).toMatchObject({ message: 'historical agent message' });
        expect(events[2].type).toBe('response_item');
    });

    it('keeps scanning for a manually resumed old session after the initial match deadline', async () => {
        const reusedSessionId = 'session-resumed-after-timeout';
        const targetCwd = '/data/github/happy/hapi';
        const startupTimestampMs = Date.now();
        const oldSessionsDir = join(testDir, 'sessions', '2025', '11', '10');
        await mkdir(oldSessionsDir, { recursive: true });
        sessionFile = join(oldSessionsDir, `codex-${reusedSessionId}.jsonl`);

        await writeFile(
            sessionFile,
            JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: reusedSessionId,
                    cwd: targetCwd,
                    timestamp: new Date(startupTimestampMs - 10 * 60 * 1000).toISOString()
                }
            }) + '\n' +
            JSON.stringify({
                type: 'event_msg',
                payload: { type: 'user_message', message: 'historical user message' }
            }) + '\n'
        );

        let matchedSessionId: string | null = null;
        let failureMessage: string | null = null;
        scanner = await createCodexSessionScanner({
            sessionId: null,
            cwd: targetCwd,
            startupTimestampMs,
            sessionStartWindowMs: 100,
            onEvent: (event) => events.push(event),
            onSessionFound: (sessionId) => {
                matchedSessionId = sessionId;
            },
            onSessionMatchFailed: (message) => {
                failureMessage = message;
            }
        });

        await wait(2500);
        expect(failureMessage).toContain('No Codex session found within 100ms');
        expect(matchedSessionId).toBeNull();
        expect(events).toHaveLength(0);

        const newLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-after-timeout', arguments: '{}' }
        });
        await appendFile(sessionFile, newLine + '\n');

        await wait(2300);
        expect(matchedSessionId).toBe(reusedSessionId);
        expect(events.map((event) => event.type)).toEqual([
            'event_msg',
            'response_item'
        ]);
        expect(events[0].payload).toMatchObject({ message: 'historical user message' });
        expect(events[1].type).toBe('response_item');
    });

    it('adopts a resumed old session from Codex state before transcript receives new events', async () => {
        const resumedSessionId = 'session-resumed-from-state';
        const targetCwd = '/data/github/happy/hapi';
        const startupTimestampMs = Date.now();
        const oldSessionsDir = join(testDir, 'sessions', '2025', '11', '10');
        await mkdir(oldSessionsDir, { recursive: true });
        sessionFile = join(oldSessionsDir, `codex-${resumedSessionId}.jsonl`);

        await writeFile(
            sessionFile,
            JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: resumedSessionId,
                    cwd: targetCwd,
                    timestamp: new Date(startupTimestampMs - 10 * 60 * 1000).toISOString()
                }
            }) + '\n' +
            JSON.stringify({
                type: 'event_msg',
                payload: { type: 'user_message', message: 'historical user message' }
            }) + '\n' +
            JSON.stringify({
                type: 'event_msg',
                payload: { type: 'agent_message', message: 'historical agent message' }
            }) + '\n'
        );

        let matchedSessionId: string | null = null;
        scanner = await createCodexSessionScanner({
            sessionId: null,
            cwd: targetCwd,
            startupTimestampMs,
            sessionStartWindowMs: 100,
            onEvent: (event) => events.push(event),
            onSessionFound: (sessionId) => {
                matchedSessionId = sessionId;
            }
        });

        await wait(2500);
        expect(matchedSessionId).toBeNull();
        expect(events).toHaveLength(0);

        const stateDbPath = join(testDir, 'state_5.sqlite');
        execFileSync('sqlite3', [
            stateDbPath,
            `
                CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    rollout_path TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    source TEXT NOT NULL,
                    model_provider TEXT NOT NULL,
                    cwd TEXT NOT NULL,
                    title TEXT NOT NULL,
                    sandbox_policy TEXT NOT NULL,
                    approval_mode TEXT NOT NULL,
                    tokens_used INTEGER NOT NULL DEFAULT 0,
                    has_user_event INTEGER NOT NULL DEFAULT 0,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at_ms INTEGER,
                    updated_at_ms INTEGER,
                    recency_at_ms INTEGER NOT NULL DEFAULT 0
                );
            `
        ]);
        const insertSql = `
            INSERT INTO threads (
                id,
                rollout_path,
                created_at,
                updated_at,
                source,
                model_provider,
                cwd,
                title,
                sandbox_policy,
                approval_mode,
                created_at_ms,
                updated_at_ms,
                recency_at_ms
            ) VALUES (
                '${resumedSessionId}',
                '${sessionFile.replace(/'/g, "''")}',
                ${Math.floor((startupTimestampMs - 10 * 60 * 1000) / 1000)},
                ${Math.floor((startupTimestampMs + 500) / 1000)},
                'codex',
                'openai',
                '${targetCwd}',
                'resumed',
                '{}',
                'default',
                ${startupTimestampMs - 10 * 60 * 1000},
                ${startupTimestampMs + 500},
                ${startupTimestampMs + 500}
            );
        `;
        execFileSync('sqlite3', [stateDbPath, insertSql]);

        await wait(2300);
        expect(matchedSessionId).toBe(resumedSessionId);
        expect(events.map((event) => event.type)).toEqual([
            'event_msg',
            'event_msg'
        ]);
        expect(events[0].payload).toMatchObject({ message: 'historical user message' });
        expect(events[1].payload).toMatchObject({ message: 'historical agent message' });
    }, 8000);

    it('does not adopt a reused session when first fresh matching activity is ambiguous', async () => {
        const targetCwd = '/data/github/happy/hapi';
        const startupTimestampMs = Date.now();
        const now = new Date(startupTimestampMs);
        const currentSessionsDir = join(
            testDir,
            'sessions',
            String(now.getFullYear()),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0')
        );
        await mkdir(currentSessionsDir, { recursive: true });

        const firstSessionId = 'session-reused-a';
        const secondSessionId = 'session-reused-b';
        const firstFile = join(currentSessionsDir, `codex-${firstSessionId}.jsonl`);
        const secondFile = join(currentSessionsDir, `codex-${secondSessionId}.jsonl`);
        const oldTimestamp = new Date(startupTimestampMs - 10 * 60 * 1000).toISOString();

        await writeFile(
            firstFile,
            JSON.stringify({
                type: 'session_meta',
                payload: { id: firstSessionId, cwd: targetCwd, timestamp: oldTimestamp }
            }) + '\n'
        );
        await writeFile(
            secondFile,
            JSON.stringify({
                type: 'session_meta',
                payload: { id: secondSessionId, cwd: targetCwd, timestamp: oldTimestamp }
            }) + '\n'
        );

        let matchedSessionId: string | null = null;
        scanner = await createCodexSessionScanner({
            sessionId: null,
            cwd: targetCwd,
            startupTimestampMs,
            onEvent: (event) => events.push(event),
            onSessionFound: (sessionId) => {
                matchedSessionId = sessionId;
            }
        });

        await wait(150);
        expect(matchedSessionId).toBeNull();

        const firstNewLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-reused-a-1', arguments: '{}' }
        });
        const secondNewLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-reused-b-1', arguments: '{}' }
        });
        await appendFile(firstFile, firstNewLine + '\n');
        await appendFile(secondFile, secondNewLine + '\n');

        await wait(2300);
        expect(matchedSessionId).toBeNull();
        expect(events).toHaveLength(0);

        const laterUniqueLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-reused-a-2', arguments: '{}' }
        });
        await appendFile(firstFile, laterUniqueLine + '\n');

        await wait(2300);
        expect(matchedSessionId).toBeNull();
        expect(events).toHaveLength(0);
    });
});
