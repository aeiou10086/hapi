import { execFileSync } from 'node:child_process';

let cachedInteractiveShellEnv: NodeJS.ProcessEnv | null = null;

function parseNullSeparatedEnv(output: Buffer): NodeJS.ProcessEnv {
  const marker = '__HAPI_ENV_START__\0';
  const text = output.toString('utf8');
  const start = text.indexOf(marker);
  const envText = start >= 0 ? text.slice(start + marker.length) : text;
  const env: NodeJS.ProcessEnv = {};

  for (const entry of envText.split('\0')) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    const key = entry.slice(0, index);
    const value = entry.slice(index + 1);
    if (key) env[key] = value;
  }

  return env;
}

export function getInteractiveShellEnv(): NodeJS.ProcessEnv {
  if (cachedInteractiveShellEnv) {
    return cachedInteractiveShellEnv;
  }

  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const output = execFileSync(shell, ['-ic', "printf '__HAPI_ENV_START__\\0'; env -0"], {
      env: process.env,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    cachedInteractiveShellEnv = parseNullSeparatedEnv(output);
  } catch {
    cachedInteractiveShellEnv = {};
  }

  return cachedInteractiveShellEnv;
}

export function mergeInteractiveShellEnv(
  env: NodeJS.ProcessEnv,
  shellEnv: NodeJS.ProcessEnv,
  options: { overrideKeys?: readonly string[] } = {}
): NodeJS.ProcessEnv {
  const overrideKeys = new Set(options.overrideKeys ?? []);
  const merged: NodeJS.ProcessEnv = { ...env };

  for (const [key, value] of Object.entries(shellEnv)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (!merged[key] || overrideKeys.has(key)) {
      merged[key] = value;
    }
  }

  return merged;
}

export function withInteractiveShellEnvFallback(
  env: NodeJS.ProcessEnv = process.env,
  options: { overrideKeys?: readonly string[] } = {}
): NodeJS.ProcessEnv {
  return mergeInteractiveShellEnv(env, getInteractiveShellEnv(), options);
}
