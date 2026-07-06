import { BaseSessionScanner, SessionFileScanEntry, SessionFileScanResult, SessionFileScanStats } from "@/modules/common/session/BaseSessionScanner";
import { logger } from "@/ui/logger";
import { join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { CodexSessionEvent } from "./codexEventConverter";

interface CodexSessionScannerOptions {
    sessionId: string | null;
    onEvent: (event: CodexSessionEvent) => void;
    onSessionFound?: (sessionId: string) => void;
    onSessionMatchFailed?: (message: string) => void;
    cwd?: string;
    startupTimestampMs?: number;
    sessionStartWindowMs?: number;
}

interface CodexSessionScanner {
    cleanup: () => Promise<void>;
    onNewSession: (sessionId: string) => void;
}

type PendingEvents = {
    events: CodexSessionEvent[];
    fileSessionId: string | null;
    historyCursor: number;
};

type Candidate = {
    sessionId: string;
    score: number;
};

type CodexStateThreadRow = {
    id: string;
    rollout_path: string;
    cwd: string;
    activity_ms: number | null;
};

const DEFAULT_SESSION_START_WINDOW_MS = 2 * 60 * 1000;

export async function createCodexSessionScanner(opts: CodexSessionScannerOptions): Promise<CodexSessionScanner> {
    const targetCwd = opts.cwd && opts.cwd.trim().length > 0 ? normalizePath(opts.cwd) : null;

    if (!targetCwd && !opts.sessionId) {
        const message = 'No cwd provided for Codex session matching; refusing to fallback.';
        logger.warn(`[CODEX_SESSION_SCANNER] ${message}`);
        opts.onSessionMatchFailed?.(message);
        return {
            cleanup: async () => {},
            onNewSession: () => {}
        };
    }

    const scanner = new CodexSessionScannerImpl(opts, targetCwd);
    await scanner.start();

    return {
        cleanup: async () => {
            await scanner.cleanup();
        },
        onNewSession: (sessionId: string) => {
            scanner.onNewSession(sessionId);
        }
    };
}

class CodexSessionScannerImpl extends BaseSessionScanner<CodexSessionEvent> {
    private readonly sessionsRoot: string;
    private readonly onEvent: (event: CodexSessionEvent) => void;
    private readonly onSessionFound?: (sessionId: string) => void;
    private readonly onSessionMatchFailed?: (message: string) => void;
    private readonly sessionIdByFile = new Map<string, string>();
    private readonly sessionCwdByFile = new Map<string, string>();
    private readonly sessionTimestampByFile = new Map<string, number>();
    private readonly pendingEventsByFile = new Map<string, PendingEvents>();
    private readonly sessionMetaParsed = new Set<string>();
    private readonly fileEpochByPath = new Map<string, number>();
    private readonly targetCwd: string | null;
    private readonly referenceTimestampMs: number;
    private readonly sessionStartWindowMs: number;
    private readonly matchDeadlineMs: number;
    private readonly sessionDatePrefixes: Set<string> | null;
    private readonly codexStateDbPath: string;

    private activeSessionId: string | null;
    private reportedSessionId: string | null;
    private matchFailed = false;
    private bestWithinWindow: Candidate | null = null;
    private readonly recentActivitySessionIds = new Set<string>();
    private readonly stateCandidateSessionIds = new Set<string>();
    private firstRecentActivityCandidateResolved = false;
    private readonly firstRecentActivitySessionIds = new Set<string>();
    private loggedAmbiguousRecentActivity = false;
    private loggedAmbiguousStateCandidate = false;

    constructor(opts: CodexSessionScannerOptions, targetCwd: string | null) {
        super({ intervalMs: 2000 });
        const codexHomeDir = process.env.CODEX_HOME || join(homedir(), '.codex');
        this.sessionsRoot = join(codexHomeDir, 'sessions');
        this.codexStateDbPath = join(codexHomeDir, 'state_5.sqlite');
        this.onEvent = opts.onEvent;
        this.onSessionFound = opts.onSessionFound;
        this.onSessionMatchFailed = opts.onSessionMatchFailed;
        this.activeSessionId = opts.sessionId;
        this.reportedSessionId = opts.sessionId;
        this.targetCwd = targetCwd;
        this.referenceTimestampMs = opts.startupTimestampMs ?? Date.now();
        this.sessionStartWindowMs = opts.sessionStartWindowMs ?? DEFAULT_SESSION_START_WINDOW_MS;
        this.matchDeadlineMs = this.referenceTimestampMs + this.sessionStartWindowMs;
        this.sessionDatePrefixes = this.targetCwd
            ? getSessionDatePrefixes(this.referenceTimestampMs, this.sessionStartWindowMs)
            : null;

        logger.debug(`[CODEX_SESSION_SCANNER] Init: targetCwd=${this.targetCwd ?? 'none'} startupTs=${new Date(this.referenceTimestampMs).toISOString()} windowMs=${this.sessionStartWindowMs}`);
    }

    public onNewSession(sessionId: string): void {
        if (this.activeSessionId === sessionId) {
            return;
        }
        logger.debug(`[CODEX_SESSION_SCANNER] Switching to new session: ${sessionId}`);
        this.setActiveSessionId(sessionId);
        this.invalidate();
    }

    protected shouldScan(): boolean {
        return true;
    }

    protected shouldWatchFile(filePath: string): boolean {
        if (!this.activeSessionId) {
            if (!this.targetCwd) {
                return false;
            }
            return this.getCandidateForFile(filePath) !== null;
        }
        const fileSessionId = this.sessionIdByFile.get(filePath);
        if (fileSessionId) {
            return fileSessionId === this.activeSessionId;
        }
        return filePath.endsWith(`-${this.activeSessionId}.jsonl`);
    }

    protected async initialize(): Promise<void> {
        const files = await this.listSessionFiles(this.sessionsRoot);
        for (const filePath of files) {
            const { nextCursor } = await this.readSessionFile(filePath, 0);
            this.setCursor(filePath, nextCursor);
            if (this.shouldWatchFile(filePath)) {
                this.ensureWatcher(filePath);
            }
        }
    }

    protected async beforeScan(): Promise<void> {
        this.bestWithinWindow = null;
        this.recentActivitySessionIds.clear();
        this.stateCandidateSessionIds.clear();
    }

    protected async findSessionFiles(): Promise<string[]> {
        const files = await this.listSessionFiles(this.sessionsRoot);
        return sortFilesByMtime(files);
    }

    protected async parseSessionFile(filePath: string, cursor: number): Promise<SessionFileScanResult<CodexSessionEvent>> {
        if (this.shouldSkipFile(filePath)) {
            return { events: [], nextCursor: cursor };
        }
        return this.readSessionFile(filePath, cursor);
    }

    protected generateEventKey(event: CodexSessionEvent, context: { filePath: string; lineIndex?: number }): string {
        const epoch = this.fileEpochByPath.get(context.filePath) ?? 0;
        const lineIndex = context.lineIndex ?? -1;
        return `${context.filePath}:${epoch}:${lineIndex}`;
    }

    protected async handleFileScan(stats: SessionFileScanStats<CodexSessionEvent>): Promise<void> {
        const filePath = stats.filePath;
        const fileSessionId = this.sessionIdByFile.get(filePath) ?? null;

        if (!this.activeSessionId && this.targetCwd) {
            this.appendPendingEvents(filePath, stats.events, fileSessionId, stats.cursor);
            const candidate = this.getCandidateForFile(filePath);
            if (candidate) {
                if (!this.bestWithinWindow || candidate.score < this.bestWithinWindow.score) {
                    this.bestWithinWindow = candidate;
                }
            }
            const recentActivityCandidate = this.getRecentActivityCandidateForFile(filePath, stats.newCount);
            if (recentActivityCandidate) {
                this.recentActivitySessionIds.add(recentActivityCandidate.sessionId);
            }
            if (stats.newCount > 0) {
                logger.debug(`[CODEX_SESSION_SCANNER] Buffered ${stats.newCount} pending events from ${filePath}`);
            }
            return;
        }

        const emittedForFile = this.emitEvents(stats.events, fileSessionId);
        if (emittedForFile > 0) {
            logger.debug(`[CODEX_SESSION_SCANNER] Emitted ${emittedForFile} new events from ${filePath}`);
        }
    }

    protected async afterScan(): Promise<void> {
        if (!this.activeSessionId && this.targetCwd) {
            if (this.bestWithinWindow) {
                logger.debug(`[CODEX_SESSION_SCANNER] Selected session ${this.bestWithinWindow.sessionId} within start window`);
                this.setActiveSessionId(this.bestWithinWindow.sessionId);
            } else {
                this.captureFirstRecentActivityCandidate();

                if (this.firstRecentActivitySessionIds.size === 1) {
                    const [sessionId] = this.firstRecentActivitySessionIds;
                    if (sessionId) {
                        logger.debug(`[CODEX_SESSION_SCANNER] Selected session ${sessionId} from first unique matching activity after startup`);
                        this.setActiveSessionId(sessionId, { flushPending: false });
                        await this.replayPendingHistoryForSession(sessionId);
                        this.flushPendingEventsForSession(sessionId);
                    }
                } else if (
                    !this.loggedAmbiguousRecentActivity
                    && this.firstRecentActivityCandidateResolved
                    && this.firstRecentActivitySessionIds.size > 1
                ) {
                    this.loggedAmbiguousRecentActivity = true;
                    logger.debug('[CODEX_SESSION_SCANNER] First matching activity after startup was ambiguous; refusing reused-session adoption');
                }

                if (!this.activeSessionId) {
                    if (this.stateCandidateSessionIds.size === 1) {
                        const [sessionId] = this.stateCandidateSessionIds;
                        if (sessionId) {
                            logger.debug(`[CODEX_SESSION_SCANNER] Selected session ${sessionId} from Codex state DB active thread candidate`);
                            this.setActiveSessionId(sessionId, { flushPending: false });
                            await this.replayHistoryForSession(sessionId);
                            this.flushPendingEventsForSession(sessionId);
                        }
                    } else if (
                        !this.loggedAmbiguousStateCandidate
                        && this.stateCandidateSessionIds.size > 1
                    ) {
                        this.loggedAmbiguousStateCandidate = true;
                        logger.debug('[CODEX_SESSION_SCANNER] Codex state DB active thread candidates were ambiguous; waiting for transcript activity');
                    }
                }

                if (!this.activeSessionId) {
                    if (!this.matchFailed && Date.now() > this.matchDeadlineMs) {
                        this.matchFailed = true;
                        this.pendingEventsByFile.clear();
                        const message = `No Codex session found within ${this.sessionStartWindowMs}ms for cwd ${this.targetCwd}; refusing fallback.`;
                        logger.warn(`[CODEX_SESSION_SCANNER] ${message}`);
                        this.onSessionMatchFailed?.(message);
                    } else if (this.pendingEventsByFile.size > 0) {
                        logger.debug('[CODEX_SESSION_SCANNER] No session candidate matched yet; pending events buffered');
                    }
                }
            }
        }
    }

    private captureFirstRecentActivityCandidate(): void {
        if (this.firstRecentActivityCandidateResolved || this.recentActivitySessionIds.size === 0) {
            return;
        }

        this.firstRecentActivityCandidateResolved = true;
        for (const sessionId of this.recentActivitySessionIds) {
            this.firstRecentActivitySessionIds.add(sessionId);
        }
    }

    private shouldSkipFile(filePath: string): boolean {
        if (!this.activeSessionId) {
            return false;
        }
        const fileSessionId = this.sessionIdByFile.get(filePath);
        if (fileSessionId && fileSessionId !== this.activeSessionId) {
            return true;
        }
        if (!fileSessionId && !filePath.endsWith(`-${this.activeSessionId}.jsonl`)) {
            return true;
        }
        return false;
    }

    private reportSessionId(sessionId: string): void {
        if (this.reportedSessionId === sessionId) {
            return;
        }
        this.reportedSessionId = sessionId;
        this.onSessionFound?.(sessionId);
    }

    private setActiveSessionId(sessionId: string, opts?: { flushPending?: boolean }): void {
        this.activeSessionId = sessionId;
        this.reportSessionId(sessionId);
        const candidateFiles = this.getFilesForSession(sessionId);
        for (const filePath of candidateFiles) {
            if (this.shouldWatchFile(filePath)) {
                this.ensureWatcher(filePath);
            }
        }
        this.pruneWatchers(this.getWatchedFiles().filter((filePath) => this.shouldWatchFile(filePath)));
        if (this.targetCwd && opts?.flushPending !== false) {
            this.flushPendingEventsForSession(sessionId);
        } else if (!this.targetCwd) {
            this.pendingEventsByFile.clear();
        }
    }

    private async listSessionFiles(dir: string): Promise<string[]> {
        const results = new Set<string>();
        await this.collectSessionFilesWithinDatePrefixes(dir, results);

        if (this.shouldScanHistoricalSessionFiles()) {
            await this.collectHistoricalSessionFiles(this.sessionsRoot, results);
        }

        this.collectRecentlyActiveCodexStateFiles(results);

        return [...results];
    }

    private async collectSessionFilesWithinDatePrefixes(dir: string, results: Set<string>): Promise<void> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const full = join(dir, entry.name);
                if (!shouldIncludeSessionPath(full, this.sessionsRoot, this.sessionDatePrefixes)) {
                    continue;
                }
                if (entry.isDirectory()) {
                    await this.collectSessionFilesWithinDatePrefixes(full, results);
                } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                    results.add(full);
                }
            }
        } catch (error) {
        }
    }

    private shouldScanHistoricalSessionFiles(): boolean {
        return Boolean(this.activeSessionId || this.targetCwd);
    }

    private async collectHistoricalSessionFiles(dir: string, results: Set<string>): Promise<void> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                    await this.collectHistoricalSessionFiles(full, results);
                    continue;
                }
                if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                    continue;
                }
                if (await this.shouldIncludeHistoricalSessionFile(full)) {
                    results.add(full);
                }
            }
        } catch (error) {
        }
    }

    private async shouldIncludeHistoricalSessionFile(filePath: string): Promise<boolean> {
        if (this.activeSessionId && filePath.endsWith(`-${this.activeSessionId}.jsonl`)) {
            return true;
        }

        if (!this.targetCwd || this.activeSessionId) {
            return false;
        }

        try {
            const fileStats = await stat(filePath);
            return fileStats.mtimeMs >= this.referenceTimestampMs - this.sessionStartWindowMs;
        } catch {
            return false;
        }
    }

    private collectRecentlyActiveCodexStateFiles(results: Set<string>): void {
        if (!this.targetCwd || this.activeSessionId || !existsSync(this.codexStateDbPath)) {
            return;
        }

        try {
            const referenceTimestampSeconds = Math.floor(this.referenceTimestampMs / 1000);
            const output = execFileSync('sqlite3', [
                '-json',
                this.codexStateDbPath,
                `
                SELECT
                    id,
                    rollout_path,
                    cwd,
                    MAX(
                        COALESCE(NULLIF(recency_at_ms, 0), 0),
                        COALESCE(updated_at_ms, 0),
                        COALESCE(updated_at * 1000, 0),
                        COALESCE(created_at_ms, 0),
                        COALESCE(created_at * 1000, 0)
                    ) AS activity_ms
                FROM threads
                WHERE archived = 0
                  AND rollout_path IS NOT NULL
                  AND rollout_path != ''
                  AND (
                    recency_at_ms >= ${this.referenceTimestampMs}
                    OR updated_at_ms >= ${this.referenceTimestampMs}
                    OR updated_at >= ${referenceTimestampSeconds}
                  )
                ORDER BY activity_ms DESC
                LIMIT 25
                `
            ], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
            const parsedRows = JSON.parse(output || '[]') as unknown;
            const rows = Array.isArray(parsedRows) ? parsedRows as CodexStateThreadRow[] : [];

            for (const row of rows) {
                const sessionId = asString(row.id);
                const rolloutPath = asString(row.rollout_path);
                const cwd = asString(row.cwd);
                if (!sessionId || !rolloutPath || !cwd) {
                    continue;
                }
                if (normalizePath(cwd) !== this.targetCwd) {
                    continue;
                }
                const activityMs = asNumber(row.activity_ms);
                if (activityMs === null || activityMs < this.referenceTimestampMs) {
                    continue;
                }
                const normalizedRolloutPath = resolve(rolloutPath);
                this.sessionIdByFile.set(normalizedRolloutPath, sessionId);
                this.sessionCwdByFile.set(normalizedRolloutPath, this.targetCwd);
                this.stateCandidateSessionIds.add(sessionId);
                results.add(normalizedRolloutPath);
            }
        } catch (error) {
            logger.debug('[CODEX_SESSION_SCANNER] Failed to read Codex state DB for active thread candidates:', error);
        }
    }

    private async readSessionFile(filePath: string, startLine: number): Promise<SessionFileScanResult<CodexSessionEvent>> {
        let content: string;
        try {
            content = await readFile(filePath, 'utf-8');
        } catch (error) {
            return { events: [], nextCursor: startLine };
        }

        const events: SessionFileScanEntry<CodexSessionEvent>[] = [];
        const lines = content.split('\n');
        const hasTrailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
        const totalLines = hasTrailingEmpty ? lines.length - 1 : lines.length;
        let effectiveStartLine = startLine;
        if (effectiveStartLine > totalLines) {
            effectiveStartLine = 0;
            const nextEpoch = (this.fileEpochByPath.get(filePath) ?? 0) + 1;
            this.fileEpochByPath.set(filePath, nextEpoch);
        }

        const hasSessionMeta = this.sessionMetaParsed.has(filePath);
        const parseFrom = hasSessionMeta ? effectiveStartLine : 0;

        for (let index = parseFrom; index < lines.length; index += 1) {
            const trimmed = lines[index].trim();
            if (!trimmed) {
                continue;
            }
            try {
                const parsed = JSON.parse(trimmed) as CodexSessionEvent;
                if (parsed?.type === 'session_meta') {
                    const payload = asRecord(parsed.payload);
                    const sessionId = payload ? asString(payload.id) : null;
                    if (sessionId) {
                        this.sessionIdByFile.set(filePath, sessionId);
                    }
                    const sessionCwd = payload ? asString(payload.cwd) : null;
                    const normalizedCwd = sessionCwd ? normalizePath(sessionCwd) : null;
                    if (normalizedCwd) {
                        this.sessionCwdByFile.set(filePath, normalizedCwd);
                    }
                    const rawTimestamp = payload ? payload.timestamp : null;
                    const sessionTimestamp = payload ? parseTimestamp(payload.timestamp) : null;
                    if (sessionTimestamp !== null) {
                        this.sessionTimestampByFile.set(filePath, sessionTimestamp);
                    }
                    logger.debug(`[CODEX_SESSION_SCANNER] Session meta: file=${filePath} cwd=${sessionCwd ?? 'none'} normalizedCwd=${normalizedCwd ?? 'none'} timestamp=${rawTimestamp ?? 'none'} parsedTs=${sessionTimestamp ?? 'none'}`);
                    this.sessionMetaParsed.add(filePath);
                }
                if (index >= effectiveStartLine) {
                    events.push({ event: parsed, lineIndex: index });
                }
            } catch (error) {
                logger.debug(`[CODEX_SESSION_SCANNER] Failed to parse line: ${error}`);
            }
        }

        return { events, nextCursor: totalLines };
    }

    private getCandidateForFile(filePath: string): Candidate | null {
        const sessionId = this.sessionIdByFile.get(filePath);
        if (!sessionId) {
            return null;
        }

        const fileCwd = this.sessionCwdByFile.get(filePath);
        if (this.targetCwd && fileCwd !== this.targetCwd) {
            return null;
        }

        const sessionTimestamp = this.sessionTimestampByFile.get(filePath);
        if (sessionTimestamp === undefined) {
            return null;
        }

        if (sessionTimestamp < this.referenceTimestampMs) {
            return null;
        }

        const diff = sessionTimestamp - this.referenceTimestampMs;
        if (diff > this.sessionStartWindowMs) {
            return null;
        }

        return {
            sessionId,
            score: diff
        };
    }

    private getRecentActivityCandidateForFile(filePath: string, newCount: number): Candidate | null {
        if (newCount <= 0) {
            return null;
        }

        const sessionId = this.sessionIdByFile.get(filePath);
        if (!sessionId) {
            return null;
        }

        const fileCwd = this.sessionCwdByFile.get(filePath);
        if (this.targetCwd && fileCwd !== this.targetCwd) {
            return null;
        }

        return {
            sessionId,
            score: 0
        };
    }

    private getFilesForSession(sessionId: string): string[] {
        const matches: string[] = [];
        for (const [filePath, storedSessionId] of this.sessionIdByFile.entries()) {
            if (storedSessionId === sessionId) {
                matches.push(filePath);
            }
        }
        if (matches.length > 0) {
            return matches;
        }
        const suffix = `-${sessionId}.jsonl`;
        return this.getWatchedFiles().filter((filePath) => filePath.endsWith(suffix));
    }

    private appendPendingEvents(filePath: string, events: CodexSessionEvent[], fileSessionId: string | null, historyCursor: number): void {
        if (events.length === 0) {
            return;
        }
        const existing = this.pendingEventsByFile.get(filePath);
        if (existing) {
            existing.events.push(...events);
            if (!existing.fileSessionId && fileSessionId) {
                existing.fileSessionId = fileSessionId;
            }
            existing.historyCursor = Math.min(existing.historyCursor, historyCursor);
            return;
        }
        this.pendingEventsByFile.set(filePath, {
            events: [...events],
            fileSessionId,
            historyCursor
        });
    }

    private async replayPendingHistoryForSession(sessionId: string): Promise<void> {
        const matchingPending = [...this.pendingEventsByFile.entries()]
            .filter(([filePath, pending]) => {
                return (pending.fileSessionId && pending.fileSessionId === sessionId)
                    || filePath.endsWith(`-${sessionId}.jsonl`);
            })
            .sort((a, b) => a[1].historyCursor - b[1].historyCursor);

        if (matchingPending.length === 0) {
            return;
        }

        let emitted = 0;
        for (const [filePath, pending] of matchingPending) {
            if (pending.historyCursor <= 0) {
                continue;
            }
            const { events } = await this.readSessionFile(filePath, 0);
            const historicalEvents = events
                .filter((entry) => (entry.lineIndex ?? -1) < pending.historyCursor)
                .map((entry) => entry.event)
                .filter((event) => event.type !== 'session_meta');
            emitted += this.emitEvents(historicalEvents, pending.fileSessionId ?? sessionId);
        }

        if (emitted > 0) {
            logger.debug(`[CODEX_SESSION_SCANNER] Emitted ${emitted} historical events for session ${sessionId}`);
        }
    }

    private async replayHistoryForSession(sessionId: string): Promise<void> {
        const files = this.getFilesForSession(sessionId).sort();
        let emitted = 0;
        for (const filePath of files) {
            const { events } = await this.readSessionFile(filePath, 0);
            const historicalEvents = events
                .map((entry) => entry.event)
                .filter((event) => event.type !== 'session_meta');
            emitted += this.emitEvents(historicalEvents, sessionId);
        }
        if (emitted > 0) {
            logger.debug(`[CODEX_SESSION_SCANNER] Emitted ${emitted} state-selected historical events for session ${sessionId}`);
        }
    }

    private emitEvents(events: CodexSessionEvent[], fileSessionId: string | null): number {
        let emittedForFile = 0;
        for (const event of events) {
            const payload = asRecord(event.payload);
            const payloadSessionId = payload ? asString(payload.id) : null;
            const eventSessionId = payloadSessionId ?? fileSessionId ?? null;

            if (this.activeSessionId && eventSessionId && eventSessionId !== this.activeSessionId) {
                continue;
            }

            this.onEvent(event);
            emittedForFile += 1;
        }
        return emittedForFile;
    }

    private flushPendingEventsForSession(sessionId: string): void {
        if (this.pendingEventsByFile.size === 0) {
            return;
        }
        let emitted = 0;
        for (const [filePath, pending] of this.pendingEventsByFile.entries()) {
            const matches = (pending.fileSessionId && pending.fileSessionId === sessionId)
                || filePath.endsWith(`-${sessionId}.jsonl`);
            if (!matches) {
                continue;
            }
            emitted += this.emitEvents(pending.events, pending.fileSessionId);
        }
        this.pendingEventsByFile.clear();
        if (emitted > 0) {
            logger.debug(`[CODEX_SESSION_SCANNER] Emitted ${emitted} pending events for session ${sessionId}`);
        }
    }
}

async function sortFilesByMtime(files: string[]): Promise<string[]> {
    const entries = await Promise.all(files.map(async (file) => {
        try {
            const stats = await stat(file);
            return { file, mtimeMs: stats.mtimeMs };
        } catch {
            return { file, mtimeMs: 0 };
        }
    }));

    return entries
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map((entry) => entry.file);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
}

function normalizePath(value: string): string {
    const resolved = resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function getSessionDatePrefixes(referenceTimestampMs: number, windowMs: number): Set<string> {
    const startDate = new Date(referenceTimestampMs - windowMs);
    const endDate = new Date(referenceTimestampMs + windowMs);
    const current = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const last = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    const prefixes = new Set<string>();

    while (current <= last) {
        const year = String(current.getFullYear());
        const month = String(current.getMonth() + 1).padStart(2, '0');
        const day = String(current.getDate()).padStart(2, '0');
        prefixes.add(`${year}/${month}/${day}`);
        current.setDate(current.getDate() + 1);
    }

    return prefixes;
}

function shouldIncludeSessionPath(
    fullPath: string,
    sessionsRoot: string,
    prefixes: Set<string> | null
): boolean {
    if (!prefixes) {
        return true;
    }

    const relativePath = relative(sessionsRoot, fullPath);
    if (!relativePath || relativePath.startsWith('..')) {
        return true;
    }

    const normalized = relativePath.split(sep).filter(Boolean).join('/');
    if (!normalized) {
        return true;
    }

    for (const prefix of prefixes) {
        if (normalized === prefix) {
            return true;
        }
        if (normalized.startsWith(`${prefix}/`)) {
            return true;
        }
        if (prefix.startsWith(`${normalized}/`)) {
            return true;
        }
    }

    return false;
}
