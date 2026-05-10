import { isClaudeModelPreset } from '@hapi/protocol'

/**
 * Context windows vary by model/provider and may change over time.
 *
 * The UI only needs this to compute a conservative "context remaining" warning.
 * We intentionally keep a headroom budget to avoid false confidence near the limit
 * (system prompts, tool overhead, and other hidden tokens can consume extra space).
 *
 * If/when the server provides an explicit per-session context limit, prefer that
 * and use this only as a fallback.
 */
const CONTEXT_HEADROOM_TOKENS = 10_000
const DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000
const LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS = 1_000_000

/**
 * Compute context-budget tokens for the active session.
 *
 * `model` is the user-picked model (null when "auto"). `resolvedModel` is the
 * binary-reported model from the SDK system/init message — used as a fallback
 * when the user picks "auto" so the budget reflects what's actually running.
 */
export function getContextBudgetTokens(
    model: string | null | undefined,
    flavor?: string | null,
    resolvedModel?: string | null
): number | null {
    if (flavor !== 'claude') {
        return null
    }

    const trimmedModel = model?.trim() || resolvedModel?.trim()
    const windowTokens = (() => {
        if (!trimmedModel) {
            return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        // [1m] suffix wins regardless of whether it's a short preset
        // (opus[1m]) or the binary-resolved full name (claude-opus-4-7-cc[1m]).
        if (trimmedModel.endsWith('[1m]')) {
            return LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        if (isClaudeModelPreset(trimmedModel)) {
            return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        if (trimmedModel.startsWith('claude-')) {
            return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        return null
    })()

    if (!windowTokens) return null
    return Math.max(1, windowTokens - CONTEXT_HEADROOM_TOKENS)
}
