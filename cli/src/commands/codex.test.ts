import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    runCodexMock,
    initializeTokenMock,
    maybeAutoStartServerMock,
    authAndSetupMachineIfNeededMock,
    isRunnerRunningCurrentlyInstalledHappyVersionMock,
    spawnHappyCLIMock
} = vi.hoisted(() => ({
    runCodexMock: vi.fn(async () => {}),
    initializeTokenMock: vi.fn(async () => {}),
    maybeAutoStartServerMock: vi.fn(async () => {}),
    authAndSetupMachineIfNeededMock: vi.fn(async () => {}),
    isRunnerRunningCurrentlyInstalledHappyVersionMock: vi.fn(async () => false),
    spawnHappyCLIMock: vi.fn(() => ({ unref: vi.fn() }))
}))

vi.mock('@/codex/runCodex', () => ({
    runCodex: runCodexMock
}))

vi.mock('@/ui/tokenInit', () => ({
    initializeToken: initializeTokenMock
}))

vi.mock('@/utils/autoStartServer', () => ({
    maybeAutoStartServer: maybeAutoStartServerMock
}))

vi.mock('@/ui/auth', () => ({
    authAndSetupMachineIfNeeded: authAndSetupMachineIfNeededMock
}))

vi.mock('@/runner/controlClient', () => ({
    isRunnerRunningCurrentlyInstalledHappyVersion: isRunnerRunningCurrentlyInstalledHappyVersionMock
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
    spawnHappyCLI: spawnHappyCLIMock
}))

import { codexCommand } from './codex'

function commandContext(commandArgs: string[]) {
    return {
        args: ['codex', ...commandArgs],
        commandArgs
    }
}

describe('codexCommand', () => {
    beforeEach(() => {
        runCodexMock.mockClear()
        initializeTokenMock.mockClear()
        maybeAutoStartServerMock.mockClear()
        authAndSetupMachineIfNeededMock.mockClear()
        isRunnerRunningCurrentlyInstalledHappyVersionMock.mockClear()
        isRunnerRunningCurrentlyInstalledHappyVersionMock.mockResolvedValue(false)
        spawnHappyCLIMock.mockClear()
    })

    it('starts hapi codex in yolo mode by default', async () => {
        await codexCommand.run(commandContext([]))

        expect(runCodexMock).toHaveBeenCalledWith({
            permissionMode: 'yolo'
        })
    })

    it('does not apply the terminal yolo default to runner-started Codex sessions', async () => {
        await codexCommand.run(commandContext(['--started-by', 'runner']))

        expect(runCodexMock).toHaveBeenCalledWith({
            startedBy: 'runner'
        })
    })

    it('lets an explicit permission mode override the yolo default', async () => {
        await codexCommand.run(commandContext(['--permission-mode', 'read-only']))

        expect(runCodexMock).toHaveBeenCalledWith({
            permissionMode: 'read-only'
        })
    })

    it('keeps explicit yolo for runner-started Codex sessions', async () => {
        await codexCommand.run(commandContext(['--started-by', 'runner', '--yolo']))

        expect(runCodexMock).toHaveBeenCalledWith({
            startedBy: 'runner',
            permissionMode: 'yolo',
            codexArgs: ['--yolo']
        })
    })

    it('starts the runner for terminal-started Codex sessions so web can spawn sessions', async () => {
        await codexCommand.run(commandContext([]))

        expect(isRunnerRunningCurrentlyInstalledHappyVersionMock).toHaveBeenCalled()
        expect(spawnHappyCLIMock).toHaveBeenCalledWith(['runner', 'start-sync'], {
            detached: true,
            stdio: 'ignore',
            env: process.env
        })
    })

    it('does not start another runner for runner-started Codex sessions', async () => {
        await codexCommand.run(commandContext(['--started-by', 'runner']))

        expect(isRunnerRunningCurrentlyInstalledHappyVersionMock).not.toHaveBeenCalled()
        expect(spawnHappyCLIMock).not.toHaveBeenCalled()
    })
})
