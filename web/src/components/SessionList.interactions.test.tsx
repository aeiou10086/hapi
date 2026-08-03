import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import type { SessionSummary } from '@/types/api'
import { SessionList } from './SessionList'

function makeSession(id: string, active: boolean): SessionSummary {
    return {
        id,
        active,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: { path: '/workspace/hapi', machineId: 'machine-1' },
        todoProgress: null,
        pendingRequestsCount: 0,
        model: null,
        effort: null,
    }
}

function renderSessionList() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    const api = {
        archiveSession: vi.fn(async () => undefined),
        deleteSession: vi.fn(async () => undefined),
    } as unknown as ApiClient

    render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <SessionList
                    sessions={[
                        makeSession('active-a', true),
                        makeSession('active-b', true),
                        makeSession('archived-a', false),
                    ]}
                    onSelect={vi.fn()}
                    onNewSession={vi.fn()}
                    onRefresh={vi.fn()}
                    isLoading={false}
                    api={api}
                    machineLabelsById={{ 'machine-1': 'Local' }}
                />
            </I18nProvider>
        </QueryClientProvider>
    )

    return { api }
}

describe('SessionList directory actions', () => {
    beforeEach(() => {
        localStorage.setItem('hapi-lang', 'en')
        window.matchMedia = vi.fn().mockReturnValue({ matches: false })
    })

    afterEach(cleanup)

    it('opens bulk archive and delete actions from the directory context menu', () => {
        renderSessionList()

        fireEvent.contextMenu(screen.getByTitle('/workspace/hapi'), { clientX: 120, clientY: 80 })

        expect(screen.getByRole('menuitem', { name: /Archive active sessions.*2/i })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: /Delete archived sessions.*1/i })).toBeInTheDocument()
    })

    it('requires confirmation with the directory and active session count before archiving', () => {
        renderSessionList()

        fireEvent.contextMenu(screen.getByTitle('/workspace/hapi'), { clientX: 120, clientY: 80 })
        fireEvent.click(screen.getByRole('menuitem', { name: /Archive active sessions.*2/i }))

        expect(screen.getByRole('heading', { name: 'Archive active sessions' })).toBeInTheDocument()
        expect(screen.getByText(/2 active sessions in "\/workspace\/hapi"/i)).toBeInTheDocument()
    })

    it('requires confirmation with the directory and archived session count before deleting', () => {
        renderSessionList()

        fireEvent.contextMenu(screen.getByTitle('/workspace/hapi'), { clientX: 120, clientY: 80 })
        fireEvent.click(screen.getByRole('menuitem', { name: /Delete archived sessions.*1/i }))

        expect(screen.getByRole('heading', { name: 'Delete archived sessions' })).toBeInTheDocument()
        expect(screen.getByText(/1 archived session in "\/workspace\/hapi"/i)).toBeInTheDocument()
    })

    it('archives every active session in the directory after confirmation', async () => {
        const { api } = renderSessionList()

        fireEvent.contextMenu(screen.getByTitle('/workspace/hapi'), { clientX: 120, clientY: 80 })
        fireEvent.click(screen.getByRole('menuitem', { name: /Archive active sessions.*2/i }))
        fireEvent.click(screen.getByRole('button', { name: 'Archive all' }))

        await waitFor(() => expect(api.archiveSession).toHaveBeenCalledTimes(2))
        expect(api.archiveSession).toHaveBeenCalledWith('active-a')
        expect(api.archiveSession).toHaveBeenCalledWith('active-b')
        expect(api.deleteSession).not.toHaveBeenCalled()
    })

    it('deletes every archived session in the directory after confirmation', async () => {
        const { api } = renderSessionList()

        fireEvent.contextMenu(screen.getByTitle('/workspace/hapi'), { clientX: 120, clientY: 80 })
        fireEvent.click(screen.getByRole('menuitem', { name: /Delete archived sessions.*1/i }))
        fireEvent.click(screen.getByRole('button', { name: 'Delete all' }))

        await waitFor(() => expect(api.deleteSession).toHaveBeenCalledTimes(1))
        expect(api.deleteSession).toHaveBeenCalledWith('archived-a')
        expect(api.archiveSession).not.toHaveBeenCalled()
    })
})
