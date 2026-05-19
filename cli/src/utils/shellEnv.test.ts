import { describe, expect, it } from 'vitest';
import { mergeInteractiveShellEnv } from './shellEnv';

describe('mergeInteractiveShellEnv', () => {
  it('fills variables that are missing from the base environment', () => {
    const merged = mergeInteractiveShellEnv(
      { PATH: '/usr/bin' },
      { CODEX_API_KEY: 'fresh-key', PATH: '/opt/bin' }
    );

    expect(merged.CODEX_API_KEY).toBe('fresh-key');
    expect(merged.PATH).toBe('/usr/bin');
  });

  it('keeps existing variables unless explicitly configured to refresh them', () => {
    const merged = mergeInteractiveShellEnv(
      { CODEX_API_KEY: 'stale-key', PATH: '/usr/bin' },
      { CODEX_API_KEY: 'fresh-key', PATH: '/opt/bin' }
    );

    expect(merged.CODEX_API_KEY).toBe('stale-key');
    expect(merged.PATH).toBe('/usr/bin');
  });

  it('refreshes selected variables from the interactive shell environment', () => {
    const merged = mergeInteractiveShellEnv(
      { CODEX_API_KEY: 'stale-key', PATH: '/usr/bin' },
      { CODEX_API_KEY: 'fresh-key', PATH: '/opt/bin' },
      { overrideKeys: ['CODEX_API_KEY'] }
    );

    expect(merged.CODEX_API_KEY).toBe('fresh-key');
    expect(merged.PATH).toBe('/usr/bin');
  });
});
