import { listSlashCommands } from '@/modules/common/slashCommands';
import type { SlashCommand } from '@/modules/common/slashCommands';
import type { ReviewTarget } from '../appServerTypes';

export type ParsedSlashCommand = {
    name: string;
    args: string;
};

export type CodexBuiltinSlashCommand =
    | { kind: 'compact' }
    | { kind: 'review'; target: ReviewTarget }
    | { kind: 'new' }
    | { kind: 'undo'; numTurns: number }
    | { kind: 'diff' }
    | { kind: 'status' }
    | { kind: 'unsupported'; name: string; reason: string };

const ARGUMENT_PLACEHOLDER_REGEX = /\$\{?ARGUMENTS\}?|\{\{\s*(?:args|arguments)\s*\}\}/gi;
const SHA_REGEX = /^[0-9a-f]{7,40}$/i;

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
    const match = /^\s*\/([a-z0-9:_-]+)(?:\s+([\s\S]*))?$/i.exec(text);
    if (!match) {
        return null;
    }

    const name = match[1]?.toLowerCase();
    if (!name) {
        return null;
    }

    return {
        name,
        args: (match[2] ?? '').trim()
    };
}

function renderPromptTemplate(content: string, args: string): string {
    if (ARGUMENT_PLACEHOLDER_REGEX.test(content)) {
        ARGUMENT_PLACEHOLDER_REGEX.lastIndex = 0;
        return content.replace(ARGUMENT_PLACEHOLDER_REGEX, args).trim();
    }

    const trimmed = content.trim();
    if (!args) {
        return trimmed;
    }

    return `${trimmed}\n\nArguments: ${args}`;
}

function commandMatches(command: SlashCommand, parsed: ParsedSlashCommand): boolean {
    return command.name.toLowerCase() === parsed.name;
}

export async function expandCodexCustomSlashCommand(text: string, projectDir: string): Promise<string | null> {
    const parsed = parseSlashCommand(text);
    if (!parsed) {
        return null;
    }

    const commands = await listSlashCommands('codex', projectDir);
    const command = commands.find((candidate) => (
        candidate.source !== 'builtin'
        && typeof candidate.content === 'string'
        && candidate.content.trim().length > 0
        && commandMatches(candidate, parsed)
    ));

    if (!command?.content) {
        return null;
    }

    return renderPromptTemplate(command.content, parsed.args);
}

function parseReviewTarget(args: string): ReviewTarget {
    const trimmed = args.trim();
    if (!trimmed) {
        return { type: 'uncommittedChanges' };
    }

    const explicit = /^(base|branch|commit)\s+(.+)$/i.exec(trimmed);
    if (explicit) {
        const kind = explicit[1]?.toLowerCase();
        const value = explicit[2]?.trim() ?? '';
        if (kind === 'commit' || SHA_REGEX.test(value)) {
            return { type: 'commit', sha: value };
        }
        return { type: 'baseBranch', branch: value };
    }

    if (SHA_REGEX.test(trimmed)) {
        return { type: 'commit', sha: trimmed };
    }

    return { type: 'baseBranch', branch: trimmed };
}

export function parseCodexBuiltinSlashCommand(text: string): CodexBuiltinSlashCommand | null {
    const parsed = parseSlashCommand(text);
    if (!parsed) {
        return null;
    }

    switch (parsed.name) {
        case 'compact':
            return { kind: 'compact' };
        case 'review':
            return { kind: 'review', target: parseReviewTarget(parsed.args) };
        case 'new':
            return { kind: 'new' };
        case 'undo': {
            const parsedTurns = Number.parseInt(parsed.args, 10);
            return { kind: 'undo', numTurns: Number.isFinite(parsedTurns) && parsedTurns > 0 ? parsedTurns : 1 };
        }
        case 'diff':
            return { kind: 'diff' };
        case 'status':
            return { kind: 'status' };
        case 'model':
        case 'permissions':
        case 'statusline':
        case 'feedback':
        case 'login':
        case 'logout':
        case 'help':
            return {
                kind: 'unsupported',
                name: parsed.name,
                reason: `/${parsed.name} is an interactive Codex TUI command that is not available in HAPI remote chat yet.`
            };
        default:
            return null;
    }
}
