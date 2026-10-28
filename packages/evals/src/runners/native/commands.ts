/**
 * Native baseline invocations: each vendor CLI invoked directly, headless,
 * with documented flags only. Sources (read 2026-10-26, no inference run):
 * - Claude Code 2.1.310 `claude --help`; headless stream-json contract as
 *   recorded in docs/reports/revamp-2026-10-26/runners.md §2.
 * - Codex CLI 0.163.0 `codex exec --help` (`--json` prints JSONL events,
 *   `-` reads the prompt from stdin, `--ignore-user-config`, `--ephemeral`).
 * - OpenCode 1.18.32 `opencode run --help` (`--format json`, `--pure`,
 *   `--auto`, `--dir`, `--variant`) and its bundled `run` command, which
 *   prints `{type, timestamp, sessionID, part|error}` objects for
 *   `tool_use`, `step_start`, `step_finish`, `text`, `reasoning`, `error`.
 *
 * Fairness rules applied to every native CLI: user/project config and MCP
 * servers are not loaded where the CLI allows it, web tools are disabled
 * when the agent network policy is not `public`, and permissions are
 * auto-approved because the trial runs inside an external sandbox.
 */

export type NativeRunnerId = 'claude-code' | 'codex' | 'opencode';
export type NativeFormat = 'claude-stream-json' | 'codex-jsonl' | 'opencode-json';

export interface NativeInvocationInput {
  runner: NativeRunnerId;
  binary: string;
  worktree: string;
  prompt: string;
  provider: string;
  model: string;
  effort: string | null;
  maxTurns: number | null;
  maxUsd: number | null;
  /** True unless the agent network policy is `public`. */
  disableWebTools: boolean;
  /** Codex sandbox mode (`danger-full-access` when an outer sandbox already isolates the run). */
  codexSandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export interface NativeInvocation {
  command: string;
  args: string[];
  /** Prompt passed on stdin (null = passed as an argument). */
  stdin: string | null;
  format: NativeFormat;
  notes: string[];
}

export const NATIVE_FORMATS: Record<NativeRunnerId, NativeFormat> = {
  'claude-code': 'claude-stream-json',
  codex: 'codex-jsonl',
  opencode: 'opencode-json',
};

export function buildNativeInvocation(input: NativeInvocationInput): NativeInvocation {
  switch (input.runner) {
    case 'claude-code': {
      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        input.model,
        '--permission-mode',
        'bypassPermissions',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--setting-sources',
        'user',
      ];
      if (input.disableWebTools) args.push('--disallowedTools', 'WebFetch,WebSearch');
      if (input.maxTurns !== null) args.push('--max-turns', String(input.maxTurns));
      if (input.maxUsd !== null) args.push('--max-budget-usd', String(input.maxUsd));
      const notes = ['prompt on stdin; cwd is the worktree'];
      if (input.effort) notes.push(`effort "${input.effort}" has no documented CLI flag in 2.1.310; set it through the model/settings and record it in the manifest`);
      if (input.maxTurns !== null) notes.push('--max-turns is not listed in `claude --help` 2.1.310 (it is part of the Agent SDK argv)');
      return { command: input.binary, args, stdin: input.prompt, format: 'claude-stream-json', notes };
    }
    case 'codex': {
      const args = ['exec', '--json', '--model', input.model, '--sandbox', input.codexSandbox ?? 'workspace-write', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-C', input.worktree];
      if (input.effort) args.push('-c', `model_reasoning_effort="${input.effort}"`);
      args.push('-');
      const notes = ['prompt on stdin (`-`)'];
      if (input.maxTurns !== null || input.maxUsd !== null) notes.push('codex exec has no turn/USD cap flag; the harness wall-clock budget is the only stop');
      if (input.disableWebTools) notes.push('web search is off unless enabled in config; --ignore-user-config keeps the user config out');
      return { command: input.binary, args, stdin: input.prompt, format: 'codex-jsonl', notes };
    }
    case 'opencode': {
      const args = ['run', '--format', 'json', '--pure', '--auto', '--model', `${input.provider}/${input.model}`, '--dir', input.worktree];
      if (input.effort) args.push('--variant', input.effort);
      args.push(input.prompt);
      const notes = ['prompt as the positional message', '--auto approves permissions; only valid inside an external sandbox'];
      if (input.maxTurns !== null || input.maxUsd !== null) notes.push('opencode run has no turn/USD cap flag; the harness wall-clock budget is the only stop');
      if (input.disableWebTools) notes.push('disable the webfetch tool through OPENCODE_CONFIG_CONTENT (permission.webfetch=deny) for no-network tracks');
      return { command: input.binary, args, stdin: null, format: 'opencode-json', notes };
    }
  }
}

export const DEFAULT_BINARIES: Record<NativeRunnerId, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
};
