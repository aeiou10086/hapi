import { render, screen } from '@testing-library/react'
import type { ElementType, ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { defaultComponents } from './assistant-ui/markdown-text'

describe('MarkdownRenderer', () => {
    it('preserves a visible blank line between markdown paragraphs', () => {
        const Paragraph = defaultComponents.p as ElementType<{ children?: ReactNode }>

        render(
            <div>
                <Paragraph>alpha</Paragraph>
                <Paragraph>beta</Paragraph>
            </div>
        )

        const first = screen.getByText('alpha')
        const second = screen.getByText('beta')
        expect(first.tagName).toBe('P')
        expect(second.tagName).toBe('P')
        expect(second).toHaveClass('mt-6')
    })
})
