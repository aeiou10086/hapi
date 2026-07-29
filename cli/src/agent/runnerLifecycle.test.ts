import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRunnerLifecycle } from './runnerLifecycle'

function createSessionStub() {
    return {
        updateMetadata: vi.fn(),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {})
    }
}

describe('createRunnerLifecycle', () => {
    const processHandlers = new Map<string, (...args: any[]) => void>()

    afterEach(() => {
        vi.restoreAllMocks()
        processHandlers.clear()
    })

    it('ignores EINTR read interruptions from terminal input', () => {
        const session = createSessionStub()
        vi.spyOn(process, 'on').mockImplementation((event, handler) => {
            processHandlers.set(String(event), handler as (...args: any[]) => void)
            return process
        })
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

        const lifecycle = createRunnerLifecycle({
            session: session as never,
            logTag: 'test'
        })
        lifecycle.registerProcessHandlers()

        processHandlers.get('uncaughtException')?.({
            code: 'EINTR',
            syscall: 'read',
            fd: 16
        })

        expect(session.sendSessionDeath).not.toHaveBeenCalled()
        expect(exitSpy).not.toHaveBeenCalled()
    })
})
