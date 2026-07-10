import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { isRunnerRunningCurrentlyInstalledHappyVersion } from '@/runner/controlClient'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { logger } from '@/ui/logger'
import type { CommandDefinition } from './types'
import { CODEX_PERMISSION_MODES } from '@hapi/protocol/modes'
import type { CodexPermissionMode } from '@hapi/protocol/types'
import type { ReasoningEffort } from '@/codex/appServerTypes'

function parseReasoningEffort(value: string): ReasoningEffort {
    switch (value) {
        case 'none':
        case 'minimal':
        case 'low':
        case 'medium':
        case 'high':
        case 'xhigh':
            return value
        default:
            throw new Error('Invalid --model-reasoning-effort value')
    }
}

export const codexCommand: CommandDefinition = {
    name: 'codex',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const { runCodex } = await import('@/codex/runCodex')

            const options: {
                startedBy?: 'runner' | 'terminal'
                codexArgs?: string[]
                permissionMode?: CodexPermissionMode
                resumeSessionId?: string
                model?: string
                modelReasoningEffort?: ReasoningEffort
            } = {}
            const unknownArgs: string[] = []
            let hasExplicitPermissionMode = false
            let hasExplicitYolo = false

            for (let i = 0; i < commandArgs.length; i++) {
                const arg = commandArgs[i]
                if (i === 0 && arg === 'resume') {
                    const candidate = commandArgs[i + 1]
                    if (!candidate || candidate.startsWith('-')) {
                        throw new Error('resume requires a session id')
                    }
                    options.resumeSessionId = candidate
                    i += 1
                    continue
                }
                if (arg === '--started-by') {
                    options.startedBy = commandArgs[++i] as 'runner' | 'terminal'
                } else if (arg === '--permission-mode') {
                    const mode = commandArgs[++i]
                    if (!mode || !(CODEX_PERMISSION_MODES as readonly string[]).includes(mode)) {
                        throw new Error(`Invalid --permission-mode value: ${mode ?? '(missing)'}`)
                    }
                    options.permissionMode = mode as CodexPermissionMode
                    hasExplicitPermissionMode = true
                } else if ((arg === '--yolo' || arg === '--dangerously-bypass-approvals-and-sandbox') && !hasExplicitPermissionMode) {
                    options.permissionMode = 'yolo'
                    hasExplicitYolo = true
                    unknownArgs.push(arg)
                } else if (arg === '--model') {
                    const model = commandArgs[++i]
                    if (!model) {
                        throw new Error('Missing --model value')
                    }
                    options.model = model
                    unknownArgs.push('--model', model)
                } else if (arg === '--model-reasoning-effort') {
                    const effort = commandArgs[++i]
                    if (!effort) {
                        throw new Error('Missing --model-reasoning-effort value')
                    }
                    options.modelReasoningEffort = parseReasoningEffort(effort)
                } else {
                    unknownArgs.push(arg)
                }
            }
            if (unknownArgs.length > 0) {
                options.codexArgs = unknownArgs
            }
            if (!options.permissionMode && options.startedBy !== 'runner' && !hasExplicitYolo) {
                options.permissionMode = 'yolo'
            }

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()
            if (options.startedBy !== 'runner') {
                logger.debug('Ensuring hapi background service is running & matches our version...')
                if (!(await isRunnerRunningCurrentlyInstalledHappyVersion())) {
                    logger.debug('Starting hapi background service...')
                    const runnerProcess = spawnHappyCLI(['runner', 'start-sync'], {
                        detached: true,
                        stdio: 'ignore',
                        env: process.env
                    })
                    runnerProcess.unref()
                    await new Promise(resolve => setTimeout(resolve, 200))
                }
            }
            await runCodex(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
