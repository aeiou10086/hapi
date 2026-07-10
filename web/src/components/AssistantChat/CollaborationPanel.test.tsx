import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'
import { CollaborationPanel } from './CollaborationPanel'

beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
            removeItem: vi.fn(),
            clear: vi.fn()
        }
    })
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

function renderStatusBar(
    codexCollaborationState: Parameters<typeof StatusBar>[0]['codexCollaborationState'],
    options: Partial<Parameters<typeof StatusBar>[0]> = {}
) {
    return render(
        <I18nProvider>
            <StatusBar
                active={true}
                thinking={true}
                agentState={null}
                agentFlavor="codex"
                codexCollaborationState={codexCollaborationState}
                {...options}
            />
        </I18nProvider>
    )
}

describe('Codex collaboration panel', () => {
    it('shows active Codex goal status with elapsed time when idle', () => {
        renderStatusBar(undefined, {
            thinking: false,
            codexGoalState: {
                threadId: 'thread-1',
                objective: 'Ship the MVP',
                status: 'active',
                timeUsedSeconds: (20 * 60 * 60) + (33 * 60)
            }
        })

        expect(screen.getByText('online')).toBeInTheDocument()
        expect(screen.getByText('Pursuing goal (20h 33m)')).toBeInTheDocument()
    })

    it('shows active Codex goal status while thinking', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0)
        renderStatusBar(undefined, {
            thinking: true,
            codexGoalState: {
                threadId: 'thread-1',
                objective: 'Ship the MVP',
                status: 'active',
                timeUsedSeconds: (20 * 60 * 60) + (33 * 60)
            }
        })

        expect(screen.getByText('accomplishing…')).toBeInTheDocument()
        expect(screen.getByText('Pursuing goal (20h 33m)')).toBeInTheDocument()
    })

    it('keeps thinking visible beside a paused Codex goal', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0)
        renderStatusBar(undefined, {
            thinking: true,
            codexGoalState: {
                threadId: 'thread-1',
                objective: 'Ship the MVP',
                status: 'paused',
                timeUsedSeconds: 120
            }
        })

        expect(screen.getByText('accomplishing…')).toBeInTheDocument()
        expect(screen.getByText('Goal paused (2m)')).toBeInTheDocument()
    })

    it('shows paused Codex goal status when idle', () => {
        renderStatusBar(undefined, {
            thinking: false,
            codexGoalState: {
                threadId: 'thread-1',
                objective: 'Ship the MVP',
                status: 'paused',
                timeUsedSeconds: 120
            }
        })

        expect(screen.getByText('Goal paused (2m)')).toBeInTheDocument()
    })

    it('shows child thread status rows while collaboration is active', () => {
        renderStatusBar({
            status: 'collaborating',
            active: true,
            activeCallCount: 1,
            childThreadCount: 2,
            lastEventAt: 100,
            childThreads: [
                {
                    threadId: 'child-a',
                    status: 'running',
                    active: true,
                    message: 'Searching files',
                    activities: [
                        { id: 'a1', type: 'message', text: 'Found validation gap', time: 100 },
                        { id: 'a2', type: 'tool', text: 'pytest tests/unit/test_gap.py', time: 110 }
                    ]
                },
                { threadId: 'child-b', status: 'completed', active: false, message: 'Done' }
            ]
        } as any)

        expect(screen.getByText('2 child threads')).toBeInTheDocument()
        expect(screen.getByText('child-a')).toBeInTheDocument()
        expect(screen.getByText('running')).toBeInTheDocument()
        expect(screen.getByText('Searching files')).toBeInTheDocument()
        expect(screen.getByText('Found validation gap')).toBeInTheDocument()
        expect(screen.getByText('pytest tests/unit/test_gap.py')).toBeInTheDocument()
        expect(screen.getByText('child-b')).toBeInTheDocument()
        expect(screen.getByText('completed')).toBeInTheDocument()
    })

    it('does not keep showing completed collaboration rows after collaboration finishes', () => {
        renderStatusBar({
            status: 'completed',
            active: false,
            activeCallCount: 0,
            childThreadCount: 1,
            lastEventAt: 200,
            completedAt: 200,
            childThreads: [
                { threadId: 'child-a', status: 'completed', active: false, message: 'Done' }
            ]
        } as any)

        expect(screen.queryByText('collaboration complete')).not.toBeInTheDocument()
        expect(screen.queryByText('Collaboration complete')).not.toBeInTheDocument()
        expect(screen.queryByText('child-a')).not.toBeInTheDocument()
        expect(screen.queryByText('Done')).not.toBeInTheDocument()
    })

    it('shows horizontal scroll controls when more than two child cards are active', () => {
        renderStatusBar({
            status: 'collaborating',
            active: true,
            activeCallCount: 0,
            childThreadCount: 3,
            lastEventAt: 100,
            childThreads: [
                { threadId: 'child-a', status: 'running', active: true },
                { threadId: 'child-b', status: 'running', active: true },
                { threadId: 'child-c', status: 'running', active: true }
            ]
        } as any)

        expect(screen.getByRole('button', { name: 'Scroll collaborations left' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Scroll collaborations right' })).toBeInTheDocument()
    })

    it('sizes cards from the available panel width', () => {
        const { rerender } = render(
            <CollaborationPanel
                state={{
                    status: 'collaborating',
                    active: true,
                    activeCallCount: 0,
                    childThreadCount: 1,
                    lastEventAt: 100,
                    childThreads: [{ threadId: 'child-a', status: 'running', active: true }]
                } as any}
            />
        )
        expect(screen.getByText('child-a').closest('[style*="flex-basis"]')).toHaveStyle({ flexBasis: '100%' })

        rerender(
            <CollaborationPanel
                state={{
                    status: 'collaborating',
                    active: true,
                    activeCallCount: 0,
                    childThreadCount: 2,
                    lastEventAt: 100,
                    childThreads: [
                        { threadId: 'child-a', status: 'running', active: true },
                        { threadId: 'child-b', status: 'running', active: true }
                    ]
                } as any}
            />
        )
        expect(screen.getByText('child-a').closest('[style*="flex-basis"]')).toHaveStyle({ flexBasis: 'calc((100% - 0.5rem) / 2)' })

        rerender(
            <CollaborationPanel
                state={{
                    status: 'collaborating',
                    active: true,
                    activeCallCount: 0,
                    childThreadCount: 3,
                    lastEventAt: 100,
                    childThreads: [
                        { threadId: 'child-a', status: 'running', active: true },
                        { threadId: 'child-b', status: 'running', active: true },
                        { threadId: 'child-c', status: 'running', active: true }
                    ]
                } as any}
            />
        )
        expect(screen.getByText('child-a').closest('[style*="flex-basis"]')).toHaveStyle({ flexBasis: 'calc(100% / 2.2)' })
    })
})
