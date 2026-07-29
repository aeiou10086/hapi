import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const terminalJobControl = vi.hoisted(() => ({
    claimTerminalForeground: vi.fn(),
    cleanup: vi.fn(),
    suspendTerminalJobControlStops: vi.fn(() => terminalJobControl.cleanup)
}));

vi.mock('@/ui/terminalJobControl', () => ({
    claimTerminalForeground: terminalJobControl.claimTerminalForeground,
    suspendTerminalJobControlStops: terminalJobControl.suspendTerminalJobControlStops
}));

import { RemoteLauncherBase, type RemoteLauncherDisplayContext } from './RemoteLauncherBase';

class TestRemoteLauncher extends RemoteLauncherBase {
    constructor() {
        super();
    }

    async runForTest(): Promise<'switch' | 'exit'> {
        return this.start({
            onExit: () => {},
            onSwitchToLocal: () => {}
        });
    }

    protected createDisplay(_context: RemoteLauncherDisplayContext): ReactElement {
        return React.createElement('div');
    }

    protected async runMainLoop(): Promise<void> {}

    protected async cleanup(): Promise<void> {}
}

describe('RemoteLauncherBase', () => {
    afterEach(() => {
        terminalJobControl.claimTerminalForeground.mockClear();
        terminalJobControl.cleanup.mockClear();
        terminalJobControl.suspendTerminalJobControlStops.mockClear();
    });

    it('claims terminal foreground and suppresses job-control stop signals while remote UI is active', async () => {
        const launcher = new TestRemoteLauncher();

        await launcher.runForTest();

        expect(terminalJobControl.suspendTerminalJobControlStops).toHaveBeenCalledTimes(1);
        expect(terminalJobControl.claimTerminalForeground).toHaveBeenCalledTimes(1);
        expect(terminalJobControl.cleanup).toHaveBeenCalledTimes(1);
    });
});
