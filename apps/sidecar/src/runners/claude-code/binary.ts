import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { executableFile, findOnPath } from '../shared/binary';

/**
 * Lowest Claude Code version this adapter drives. 2.1.259 added
 * `--permission-prompts`; `interrupt_receipt_v1` (2.1.205) and the
 * `system/init` capabilities list are older. Verified against 2.1.310.
 */
export const MIN_CLAUDE_CODE_VERSION: [number, number, number] = [2, 1, 259];
export const MIN_CLAUDE_CODE_VERSION_TEXT = MIN_CLAUDE_CODE_VERSION.join('.');

export interface ClaudeBinary {
  /** Real path of the official `claude` executable (or its npm cli.js). */
  path: string;
  /** Extra directory readable in the sandbox (npm installs: the package dir). */
  readRoot: string | null;
  source: 'override' | 'path' | 'known-location';
}

function known(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? homedir();
  return [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
}

function describe(path: string, source: ClaudeBinary['source']): ClaudeBinary {
  // An npm install resolves to `.../@anthropic-ai/claude-code/cli.js`, run by
  // node; the whole package (vendored ripgrep, wasm) must be readable.
  const script = /\.(c|m)?js$/.test(path);
  return { path, readRoot: script ? dirname(path) : null, source };
}

/**
 * The user's own, unmodified `claude` binary. Never resolved from the agent
 * worktree (PATH entries are absolute; the launcher refuses a binary inside
 * the worktree). `OPENLINEAR_CLAUDE_PATH` overrides.
 */
export function resolveClaudeBinary(env: NodeJS.ProcessEnv = process.env): ClaudeBinary | null {
  if (env.OPENLINEAR_CLAUDE_PATH) {
    const path = executableFile(env.OPENLINEAR_CLAUDE_PATH);
    return path ? describe(path, 'override') : null;
  }
  const onPath = findOnPath('claude', env.PATH);
  if (onPath) return describe(onPath, 'path');
  for (const candidate of known(env)) {
    const path = executableFile(candidate);
    if (path) return describe(path, 'known-location');
  }
  return null;
}

/** Where the user's own Claude Code keeps a file-based login (Linux; macOS Keychain fallback). */
export function claudeCredentialsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude'), '.credentials.json');
}

/** `claude-opus-5-5`, `anthropic/claude-opus-5-5`, `opus` → the id Claude Code accepts. */
export function claudeModelArg(model: { provider?: string; id: string } | undefined): string | undefined {
  if (!model?.id) return undefined;
  const id = model.id.startsWith('anthropic/') ? model.id.slice('anthropic/'.length) : model.id;
  return /^[A-Za-z0-9._:[\]-]{1,128}$/.test(id) ? id : undefined;
}
