import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { MachineCache } from './machineCache'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

describe('alive incremental events', () => {
    it('includes active=true in session alive updates', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-alive-test',
            { path: '/tmp/project', host: 'localhost' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        events.length = 0
        cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })

        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ active: true }))
    })

    it('persists session alive activity so a reloaded cache keeps the session active', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-alive-persistence-test',
            { path: '/tmp/project', host: 'localhost' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        const aliveAt = Date.now()
        cache.handleSessionAlive({ sid: session.id, time: aliveAt, thinking: false })

        const stored = store.sessions.getSession(session.id)
        expect(stored?.active).toBe(true)
        expect(stored?.activeAt).toBeGreaterThanOrEqual(aliveAt)

        const reloadedCache = new SessionCache(store, createPublisher([]))
        reloadedCache.reloadAll()
        const reloaded = reloadedCache.getSession(session.id)
        expect(reloaded?.active).toBe(true)
        expect(reloaded?.activeAt).toBeGreaterThanOrEqual(aliveAt)
    })

    it('persists session end activity so a reloaded cache keeps the session inactive', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))

        const session = cache.getOrCreateSession(
            'session-end-persistence-test',
            { path: '/tmp/project', host: 'localhost' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
        cache.handleSessionEnd({ sid: session.id, time: Date.now() })

        expect(store.sessions.getSession(session.id)?.active).toBe(false)

        const reloadedCache = new SessionCache(store, createPublisher([]))
        reloadedCache.reloadAll()
        expect(reloadedCache.getSession(session.id)?.active).toBe(false)
    })

    it('persists inactivity expiry so stale active sessions do not revive after reload', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createPublisher([]))

        const session = cache.getOrCreateSession(
            'session-expire-persistence-test',
            { path: '/tmp/project', host: 'localhost' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        const aliveAt = Date.now()
        cache.handleSessionAlive({ sid: session.id, time: aliveAt, thinking: false })
        cache.expireInactive(aliveAt + 60_000)

        expect(store.sessions.getSession(session.id)?.active).toBe(false)

        const reloadedCache = new SessionCache(store, createPublisher([]))
        reloadedCache.reloadAll()
        expect(reloadedCache.getSession(session.id)?.active).toBe(false)
    })

    it('includes Codex collaboration state in session alive updates', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-collaboration-state-test',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        const codexCollaborationState = {
            status: 'collaborating' as const,
            active: true,
            activeCallCount: 1,
            childThreadCount: 1,
            lastEventAt: Date.now()
        }

        events.length = 0
        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: true,
            codexCollaborationState
        })

        expect(cache.getSession(session.id)?.codexCollaborationState).toEqual(codexCollaborationState)

        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ codexCollaborationState }))
    })

    it('includes Codex goal state in session alive updates', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-goal-state-test',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        const codexGoalState = {
            threadId: 'thread-1',
            objective: 'Ship the MVP',
            status: 'active',
            timeUsedSeconds: 73980
        }

        events.length = 0
        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            codexGoalState
        })

        expect(cache.getSession(session.id)?.codexGoalState).toEqual(codexGoalState)

        const update = events.find((event) => event.type === 'session-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'session-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ codexGoalState }))
    })

    it('emits full active machine object on machine alive', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new MachineCache(store, createPublisher(events))

        const machine = cache.getOrCreateMachine(
            'machine-alive-test',
            { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            null,
            'default'
        )

        events.length = 0
        cache.handleMachineAlive({ machineId: machine.id, time: Date.now() })

        const update = events.find((event) => event.type === 'machine-updated')
        expect(update).toBeDefined()
        if (!update || update.type !== 'machine-updated') {
            return
        }

        expect(update.data).toEqual(expect.objectContaining({ id: machine.id, active: true }))
    })
})
