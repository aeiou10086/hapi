import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

vi.mock('@tanstack/react-query', () => ({
    useQueryClient: () => ({
        clear: vi.fn(),
        invalidateQueries: vi.fn(async () => undefined),
    }),
}))

vi.mock('@tanstack/react-router', () => ({
    Outlet: () => null,
    useLocation: () => '/sessions',
    useMatchRoute: () => () => false,
    useRouter: () => ({
        history: {
            location: { pathname: '/sessions', search: '', hash: '', state: null },
            replace: vi.fn(),
        },
    }),
}))

vi.mock('@/hooks/useTelegram', () => ({
    getTelegramWebApp: () => null,
    isTelegramApp: () => false,
}))
vi.mock('@/hooks/useTheme', () => ({ initializeTheme: vi.fn() }))
vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({
        token: null,
        api: null,
        isLoading: false,
        error: null,
        needsBinding: false,
        bind: vi.fn(),
    }),
}))
vi.mock('@/hooks/useAuthSource', () => ({
    useAuthSource: () => ({ authSource: null, isLoading: false, setAccessToken: vi.fn() }),
}))
vi.mock('@/hooks/useServerUrl', () => ({
    useServerUrl: () => ({
        serverUrl: '',
        baseUrl: '',
        setServerUrl: vi.fn(),
        clearServerUrl: vi.fn(),
    }),
}))
vi.mock('@/hooks/useAppGoBack', () => ({ useAppGoBack: () => vi.fn() }))
vi.mock('@/hooks/useViewportHeight', () => ({ useViewportHeight: vi.fn() }))
vi.mock('@/hooks/useSyncingState', () => ({
    useSyncingState: () => ({ isSyncing: false, startSync: vi.fn(), endSync: vi.fn() }),
}))
vi.mock('@/hooks/usePushNotifications', () => ({
    usePushNotifications: () => ({
        isSupported: false,
        permission: 'default',
        requestPermission: vi.fn(),
        subscribe: vi.fn(),
    }),
}))
vi.mock('@/hooks/useSSE', () => ({ useSSE: () => ({ subscriptionId: null }) }))
vi.mock('@/hooks/useVisibilityReporter', () => ({ useVisibilityReporter: vi.fn() }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/runtime-config', () => ({ requireHubUrlForLogin: () => false }))
vi.mock('@/lib/toast-context', () => ({
    ToastProvider: ({ children }: { children: React.ReactNode }) => children,
    useToast: () => ({ addToast: vi.fn() }),
}))
vi.mock('@/components/LoginPrompt', () => ({ LoginPrompt: () => null }))

describe('App browser zoom', () => {
    afterEach(cleanup)

    it('leaves native keyboard and trackpad zoom events unhandled', () => {
        render(<App />)

        const keyEvent = new KeyboardEvent('keydown', {
            key: '+',
            metaKey: true,
            bubbles: true,
            cancelable: true,
        })
        const wheelEvent = new WheelEvent('wheel', {
            deltaY: -100,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        })

        expect(window.dispatchEvent(keyEvent)).toBe(true)
        expect(keyEvent.defaultPrevented).toBe(false)
        expect(window.dispatchEvent(wheelEvent)).toBe(true)
        expect(wheelEvent.defaultPrevented).toBe(false)
    })
})
