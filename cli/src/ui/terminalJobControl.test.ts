import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({
    execFileSync: vi.fn()
}));

vi.mock('node:child_process', () => childProcess);

import { claimTerminalForeground, suspendTerminalJobControlStops } from './terminalJobControl';

describe('suspendTerminalJobControlStops', () => {
    const handlers: Array<{ signal: NodeJS.Signals; handler: NodeJS.SignalsListener }> = [];
    const originalPlatform = process.platform;

    afterEach(() => {
        vi.restoreAllMocks();
        childProcess.execFileSync.mockClear();
        Object.defineProperty(process, 'platform', {
            value: originalPlatform
        });
        Object.defineProperty(process.stdin, 'isTTY', {
            configurable: true,
            value: undefined
        });
        handlers.length = 0;
    });

    it('temporarily handles terminal job-control stop signals on POSIX', () => {
        Object.defineProperty(process, 'platform', {
            value: 'darwin'
        });
        const onSpy = vi.spyOn(process, 'on').mockImplementation((signal, handler) => {
            handlers.push({ signal: signal as NodeJS.Signals, handler: handler as NodeJS.SignalsListener });
            return process;
        });
        const offSpy = vi.spyOn(process, 'off').mockImplementation(() => process);

        const cleanup = suspendTerminalJobControlStops();

        expect(onSpy).toHaveBeenCalledWith('SIGTTIN', expect.any(Function));
        expect(onSpy).toHaveBeenCalledWith('SIGTTOU', expect.any(Function));

        cleanup();

        expect(offSpy).toHaveBeenCalledWith('SIGTTIN', handlers[0]?.handler);
        expect(offSpy).toHaveBeenCalledWith('SIGTTOU', handlers[1]?.handler);
    });

    it('does not install job-control handlers on Windows', () => {
        Object.defineProperty(process, 'platform', {
            value: 'win32'
        });
        const onSpy = vi.spyOn(process, 'on');

        const cleanup = suspendTerminalJobControlStops();
        cleanup();

        expect(onSpy).not.toHaveBeenCalled();
    });

    it('claims terminal foreground on POSIX TTYs', () => {
        Object.defineProperty(process, 'platform', {
            value: 'darwin'
        });
        Object.defineProperty(process.stdin, 'isTTY', {
            configurable: true,
            value: true
        });
        childProcess.execFileSync.mockReturnValueOnce('34283\n');
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

        claimTerminalForeground();

        expect(childProcess.execFileSync).toHaveBeenNthCalledWith(1, 'ps', [
            '-o',
            'pgid=,tpgid=',
            '-p',
            String(process.pid)
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        expect(childProcess.execFileSync).toHaveBeenNthCalledWith(2, 'perl', [
            '-MPOSIX=tcsetpgrp',
            '-e',
            '$SIG{TTOU} = "IGNORE"; open(my $tty, "+<", "/dev/tty") or die "open /dev/tty failed: $!\\n"; tcsetpgrp(fileno($tty), int($ARGV[0])) or die "tcsetpgrp failed: $!\\n"',
            '34283'
        ], {
            stdio: ['ignore', 'ignore', 'pipe']
        });
        expect(childProcess.execFileSync).toHaveBeenNthCalledWith(3, 'ps', [
            '-o',
            'pgid=,tpgid=',
            '-p',
            String(process.pid)
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        expect(killSpy).toHaveBeenCalledWith(-34283, 'SIGCONT');
    });

    it('does not claim terminal foreground when stdin is not a TTY', () => {
        Object.defineProperty(process, 'platform', {
            value: 'darwin'
        });
        Object.defineProperty(process.stdin, 'isTTY', {
            configurable: true,
            value: false
        });

        claimTerminalForeground();

        expect(childProcess.execFileSync).not.toHaveBeenCalled();
    });
});
