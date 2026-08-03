import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties
} from 'react'
import { useTranslation } from '@/lib/use-translation'

type DirectoryActionMenuProps = {
    isOpen: boolean
    onClose: () => void
    onArchive: () => void
    onDelete: () => void
    activeCount: number
    archivedCount: number
    disabled?: boolean
    anchorPoint: { x: number; y: number }
}

function ArchiveIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <rect width="20" height="5" x="2" y="3" rx="1" />
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
            <path d="M10 12h4" />
        </svg>
    )
}

function TrashIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            <line x1="10" x2="10" y1="11" y2="17" />
            <line x1="14" x2="14" y1="11" y2="17" />
        </svg>
    )
}

type MenuPosition = {
    top: number
    left: number
    transformOrigin: string
}

export function DirectoryActionMenu(props: DirectoryActionMenuProps) {
    const { t } = useTranslation()
    const menuRef = useRef<HTMLDivElement | null>(null)
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
    const internalId = useId()
    const headingId = `directory-action-menu-${internalId}-heading`

    const updatePosition = useCallback(() => {
        const menuEl = menuRef.current
        if (!menuEl) return

        const menuRect = menuEl.getBoundingClientRect()
        const padding = 8
        const gap = 8
        const spaceBelow = window.innerHeight - props.anchorPoint.y
        const spaceAbove = props.anchorPoint.y
        const openAbove = spaceBelow < menuRect.height + gap && spaceAbove > spaceBelow
        let top = openAbove
            ? props.anchorPoint.y - menuRect.height - gap
            : props.anchorPoint.y + gap
        let left = props.anchorPoint.x - menuRect.width / 2

        top = Math.min(Math.max(top, padding), window.innerHeight - menuRect.height - padding)
        left = Math.min(Math.max(left, padding), window.innerWidth - menuRect.width - padding)
        setMenuPosition({
            top,
            left,
            transformOrigin: openAbove ? 'bottom center' : 'top center'
        })
    }, [props.anchorPoint])

    useLayoutEffect(() => {
        if (props.isOpen) updatePosition()
    }, [props.isOpen, updatePosition])

    useEffect(() => {
        if (!props.isOpen) {
            setMenuPosition(null)
            return
        }

        const handlePointerDown = (event: PointerEvent) => {
            if (!menuRef.current?.contains(event.target as Node)) props.onClose()
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') props.onClose()
        }
        const handleReflow = () => updatePosition()

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        window.addEventListener('resize', handleReflow)
        window.addEventListener('scroll', handleReflow, true)
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
            window.removeEventListener('resize', handleReflow)
            window.removeEventListener('scroll', handleReflow, true)
        }
    }, [props.isOpen, props.onClose, updatePosition])

    useEffect(() => {
        if (!props.isOpen) return
        const frame = window.requestAnimationFrame(() => {
            menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
        })
        return () => window.cancelAnimationFrame(frame)
    }, [props.isOpen])

    if (!props.isOpen) return null

    const menuStyle: CSSProperties | undefined = menuPosition
        ? {
            top: menuPosition.top,
            left: menuPosition.left,
            transformOrigin: menuPosition.transformOrigin
        }
        : undefined
    const baseItemClassName = 'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-40'

    return (
        <div
            ref={menuRef}
            className="fixed z-50 min-w-[240px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg animate-menu-pop"
            style={menuStyle}
        >
            <div id={headingId} className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                {t('directory.action.heading')}
            </div>
            <div role="menu" aria-labelledby={headingId} className="flex flex-col gap-1">
                <button
                    type="button"
                    role="menuitem"
                    disabled={props.disabled || props.activeCount === 0}
                    className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                    onClick={() => {
                        props.onClose()
                        props.onArchive()
                    }}
                >
                    <ArchiveIcon className="h-[18px] w-[18px] shrink-0 text-[var(--app-hint)]" />
                    <span className="flex-1">{t('directory.action.archive')}</span>
                    <span className="min-w-5 rounded-full bg-[var(--app-secondary-bg)] px-1.5 py-0.5 text-center text-[11px] tabular-nums text-[var(--app-hint)]">
                        {props.activeCount}
                    </span>
                </button>
                <button
                    type="button"
                    role="menuitem"
                    disabled={props.disabled || props.archivedCount === 0}
                    className={`${baseItemClassName} text-red-500 hover:bg-red-500/10`}
                    onClick={() => {
                        props.onClose()
                        props.onDelete()
                    }}
                >
                    <TrashIcon className="h-[18px] w-[18px] shrink-0" />
                    <span className="flex-1">{t('directory.action.delete')}</span>
                    <span className="min-w-5 rounded-full bg-red-500/10 px-1.5 py-0.5 text-center text-[11px] tabular-nums">
                        {props.archivedCount}
                    </span>
                </button>
            </div>
        </div>
    )
}
