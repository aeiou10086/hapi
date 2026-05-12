import { describe, expect, it } from 'vitest'
import { findUnsupportedCodexBuiltinSlashCommand, getBuiltinSlashCommands } from './codexSlashCommands'

describe('getBuiltinSlashCommands', () => {
    it('exposes supported codex built-ins in remote web mode', () => {
        expect(getBuiltinSlashCommands('codex').map(command => command.name)).toEqual([
            'compact',
            'diff',
            'new',
            'review',
            'status',
            'undo',
        ])
    })
})

describe('findUnsupportedCodexBuiltinSlashCommand', () => {
    it('does not block supported codex built-ins', () => {
        expect(findUnsupportedCodexBuiltinSlashCommand('/status', [])).toBeNull()
        expect(findUnsupportedCodexBuiltinSlashCommand('  /diff ', [])).toBeNull()
    })

    it('ignores regular messages and unknown commands', () => {
        expect(findUnsupportedCodexBuiltinSlashCommand('show me status', [])).toBeNull()
        expect(findUnsupportedCodexBuiltinSlashCommand('/custom-status', [])).toBeNull()
    })

    it('does not block custom commands that override the same name', () => {
        expect(findUnsupportedCodexBuiltinSlashCommand('/status', [
            { name: 'status', source: 'project', content: 'project status prompt' }
        ])).toBeNull()
    })
})
