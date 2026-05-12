import { describe, expect, it } from 'vitest'
import { extractCodexPatchChanges } from './codexPatch'

describe('extractCodexPatchChanges', () => {
    it('extracts path-keyed changes', () => {
        expect(extractCodexPatchChanges({
            changes: {
                'src/a.ts': { diff: '@@ -1 +1 @@' }
            }
        })).toEqual([{ key: 'src/a.ts', path: 'src/a.ts', diff: '@@ -1 +1 @@', kind: undefined }])
    })

    it('extracts array changes without displaying numeric keys as paths', () => {
        expect(extractCodexPatchChanges({
            changes: [{ path: '/repo/src/a.ts', diff: '@@ -1 +1 @@' }]
        })).toEqual([{ key: '0', path: '/repo/src/a.ts', diff: '@@ -1 +1 @@', kind: undefined }])
    })
})
