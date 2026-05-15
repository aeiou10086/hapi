import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'

afterEach(() => {
    cleanup()
})

function renderStatusBar(codexCollaborationState: Parameters<typeof StatusBar>[0]['codexCollaborationState']) {
    return render(
        <I18nProvider>
            <StatusBar
                active={true}
                thinking={true}
                agentState={null}
                agentFlavor="codex"
                codexCollaborationState={codexCollaborationState}
            />
        </I18nProvider>
    )
}

describe('Codex collaboration panel', () => {
    it('shows child thread status rows while collaboration is active', () => {
        renderStatusBar({
            status: 'collaborating',
            active: true,
            activeCallCount: 1,
            childThreadCount: 2,
            lastEventAt: 100,
            childThreads: [
                { threadId: 'child-a', status: 'running', active: true, message: 'Searching files' },
                { threadId: 'child-b', status: 'completed', active: false, message: 'Done' }
            ]
        } as any)

        expect(screen.getByText('2 child threads')).toBeInTheDocument()
        expect(screen.getByText('child-a')).toBeInTheDocument()
        expect(screen.getByText('running')).toBeInTheDocument()
        expect(screen.getByText('Searching files')).toBeInTheDocument()
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
})
