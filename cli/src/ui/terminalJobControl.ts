import { logger } from '@/ui/logger';
import { execFileSync } from 'node:child_process';

const JOB_CONTROL_STOP_SIGNALS: NodeJS.Signals[] = ['SIGTTIN', 'SIGTTOU'];

export function suspendTerminalJobControlStops(): () => void {
    if (process.platform === 'win32') {
        return () => {};
    }

    const handlers: Array<{ signal: NodeJS.Signals; handler: NodeJS.SignalsListener }> = [];

    for (const signal of JOB_CONTROL_STOP_SIGNALS) {
        const handler: NodeJS.SignalsListener = () => {
            logger.debug(`[terminal-job-control] Ignored ${signal} while remote terminal UI is active`);
        };

        try {
            process.on(signal, handler);
            handlers.push({ signal, handler });
        } catch (error) {
            logger.debug(`[terminal-job-control] Failed to install ${signal} handler`, error);
        }
    }

    return () => {
        for (const { signal, handler } of handlers) {
            try {
                process.off(signal, handler);
            } catch (error) {
                logger.debug(`[terminal-job-control] Failed to remove ${signal} handler`, error);
            }
        }
    };
}

export function claimTerminalForeground(): void {
    if (process.platform === 'win32' || !process.stdin.isTTY) {
        return;
    }

    const before = getCurrentTerminalState();
    if (!before?.pgid) {
        return;
    }

    try {
        execFileSync('perl', [
            '-MPOSIX=tcsetpgrp',
            '-e',
            '$SIG{TTOU} = "IGNORE"; open(my $tty, "+<", "/dev/tty") or die "open /dev/tty failed: $!\\n"; tcsetpgrp(fileno($tty), int($ARGV[0])) or die "tcsetpgrp failed: $!\\n"',
            String(before.pgid)
        ], {
            stdio: ['ignore', 'ignore', 'pipe']
        });
        const after = getCurrentTerminalState();
        logger.debug('[terminal-job-control] Claimed terminal foreground', {
            pid: process.pid,
            before,
            after,
            targetPgid: before.pgid
        });
        continueProcessGroup(before.pgid);
    } catch (error) {
        logger.debug('[terminal-job-control] Failed to claim terminal foreground', {
            pid: process.pid,
            before,
            error
        });
    }
}

type TerminalState = {
    pgid: number | null;
    tpgid: number | null;
};

function getCurrentTerminalState(): TerminalState | null {
    try {
        const output = execFileSync('ps', [
            '-o',
            'pgid=,tpgid=',
            '-p',
            String(process.pid)
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const [pgidText, tpgidText] = output.trim().split(/\s+/);
        return {
            pgid: parsePositiveInteger(pgidText),
            tpgid: parsePositiveInteger(tpgidText)
        };
    } catch (error) {
        logger.debug('[terminal-job-control] Failed to read terminal process group state', error);
    }

    return null;
}

function parsePositiveInteger(value: string | undefined): number | null {
    if (!value) {
        return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function continueProcessGroup(pgid: number): void {
    try {
        process.kill(-pgid, 'SIGCONT');
    } catch (error) {
        logger.debug('[terminal-job-control] Failed to continue process group after foreground claim', error);
    }
}
