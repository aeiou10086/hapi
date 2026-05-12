import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    expandCodexCustomSlashCommand,
    parseCodexBuiltinSlashCommand,
    parseSlashCommand
} from './slashCommand'

describe('Codex slash command helpers', () => {
    const originalCodexHome = process.env.CODEX_HOME
    let sandboxDir: string
    let codexHome: string
    let projectDir: string

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-codex-slash-'))
        codexHome = join(sandboxDir, 'codex-home')
        projectDir = join(sandboxDir, 'project')
        process.env.CODEX_HOME = codexHome
        await mkdir(join(codexHome, 'prompts'), { recursive: true })
        await mkdir(join(projectDir, '.codex', 'prompts'), { recursive: true })
    })

    afterEach(async () => {
        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME
        } else {
            process.env.CODEX_HOME = originalCodexHome
        }
        await rm(sandboxDir, { recursive: true, force: true })
    })

    it('parses slash commands with arguments', () => {
        expect(parseSlashCommand('  /review base main ')).toEqual({ name: 'review', args: 'base main' })
        expect(parseSlashCommand('not a command')).toBeNull()
    })

    it('expands Codex project prompts and substitutes arguments', async () => {
        await writeFile(
            join(projectDir, '.codex', 'prompts', 'fix.md'),
            ['---', 'description: Fix bug', '---', '', 'Fix this: $ARGUMENTS'].join('\n')
        )

        await expect(expandCodexCustomSlashCommand('/fix login bug', projectDir))
            .resolves.toBe('Fix this: login bug')
    })

    it('lets project prompts override global Codex prompts', async () => {
        await writeFile(join(codexHome, 'prompts', 'ship.md'), 'Global $ARGUMENTS')
        await writeFile(join(projectDir, '.codex', 'prompts', 'ship.md'), 'Project {{args}}')

        await expect(expandCodexCustomSlashCommand('/ship feature', projectDir))
            .resolves.toBe('Project feature')
    })

    it('classifies supported Codex built-ins', () => {
        expect(parseCodexBuiltinSlashCommand('/compact')).toEqual({ kind: 'compact' })
        expect(parseCodexBuiltinSlashCommand('/review main')).toEqual({
            kind: 'review',
            target: { type: 'baseBranch', branch: 'main' }
        })
        expect(parseCodexBuiltinSlashCommand('/undo 3')).toEqual({ kind: 'undo', numTurns: 3 })
        expect(parseCodexBuiltinSlashCommand('/status')).toEqual({ kind: 'status' })
    })
})
