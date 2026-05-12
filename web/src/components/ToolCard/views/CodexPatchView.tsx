import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { basename, resolveDisplayPath } from '@/utils/path'
import { CodeBlock } from '@/components/CodeBlock'
import { extractCodexPatchChanges } from '@/components/ToolCard/codexPatch'

export function CodexPatchView(props: ToolViewProps) {
    const changes = extractCodexPatchChanges(props.block.tool.input)
    if (changes.length === 0) return null

    return (
        <div className="flex flex-col gap-3">
            {changes.map((change) => {
                const display = resolveDisplayPath(change.path, props.metadata)
                return (
                    <div key={`${change.key}:${change.path}`} className="flex flex-col gap-1.5">
                        <div className="text-sm text-[var(--app-fg)] font-mono break-all">
                            {basename(display)}
                        </div>
                        {change.diff ? (
                            <CodeBlock code={change.diff} language="diff" />
                        ) : null}
                    </div>
                )
            })}
        </div>
    )
}
