import { isObject } from '@hapi/protocol'

export type CodexPatchChange = {
    key: string
    path: string
    diff: string | null
    kind: unknown
}

function getString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function pathFromChange(key: string, value: unknown): string {
    if (isObject(value)) {
        return getString(value.path)
            ?? getString(value.file)
            ?? getString(value.filePath)
            ?? getString(value.file_path)
            ?? key
    }
    return key
}

function changeFromEntry(key: string, value: unknown): CodexPatchChange {
    return {
        key,
        path: pathFromChange(key, value),
        diff: isObject(value) ? getString(value.diff) : null,
        kind: isObject(value) ? value.kind : null
    }
}

export function extractCodexPatchChanges(input: unknown): CodexPatchChange[] {
    if (!isObject(input)) return []
    const rawChanges = input.changes

    if (Array.isArray(rawChanges)) {
        return rawChanges.map((change, index) => changeFromEntry(String(index), change))
    }

    if (isObject(rawChanges)) {
        return Object.entries(rawChanges).map(([key, change]) => changeFromEntry(key, change))
    }

    if (getString(input.path) || getString(input.file) || getString(input.filePath) || getString(input.file_path)) {
        return [changeFromEntry('0', input)]
    }

    return []
}
