import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentRunner,
  AgentSession,
  ModelDescriptor,
  PermissionPolicy,
  ResumeInput,
  RunnerAuthStatus,
  RunnerCapabilities,
  RunnerFeatures,
  RunnerHealth,
  StartInput,
} from '@openlinear/execution-core';
import { buildRunnerProcessEnv } from '../../sandbox/env';
import { resolveSandboxMode } from '../../sandbox/mode';
import { parseSemver, runShortCommand, semverAtLeast } from '../shared/binary';
import { RESUME_CONTINUATION_PROMPT } from '../shared/continuation';
import { RunnerAuthUnavailableError, RunnerUnavailableError } from '../shared/errors';
import { isRecord } from '../shared/jsonl';
import {
  findSessionFile,
  launchRunnerProcess,
  runnerRuntimeDir,
  type LoginFileAllowance,
  type RunnerProcess,
  type RunnerProcessSpec,
} from '../shared/sandboxed-process';
import {
  type ClaudeBinary,
  claudeCredentialsFile,
  claudeModelArg,
  MIN_CLAUDE_CODE_VERSION,
  MIN_CLAUDE_CODE_VERSION_TEXT,
  resolveClaudeBinary,
} from './binary';
import { ClaudeCodeSession } from './session';

/**
 * W07 Claude Code runner: spawns the user's own, unmodified `claude` binary
 * in headless streaming mode under the SandboxProvider. It never reads,
 * copies or relays the user's Claude credentials: the CLI authenticates
 * itself, either with the user's own login state (made readable read-only,
 * see `loginPlan`) or with an Anthropic API key passed explicitly for the run.
 *
 * CLI contract (verified against Claude Code 2.1.310 `--help`, the headless
 * docs and the Agent SDK 0.3.310 typings):
 *   claude -p --output-format stream-json --verbose --include-partial-messages
 *     --input-format stream-json --setting-sources user --strict-mcp-config
 *     --append-system-prompt <contract> (--session-id <uuid> | --resume <id>)
 *     [--model <id>] [--max-turns N] [--max-budget-usd X] <permission flags>
 * The prompt is one stream-json user message on stdin; stdin stays open for
 * control requests (interrupt, permission answers) until the result arrives.
 */

const CAPABILITIES: RunnerCapabilities = {
  streamingDeltas: true,
  // thinking_delta is decoded; Claude Code's default thinking display may
  // leave it empty on current models.
  reasoningDeltas: true,
  permissionReply: true,
  interrupt: true,
  compact: false,
  revert: false,
  fork: false,
  cacheSplitUsage: true,
};

const FEATURES: RunnerFeatures = {
  resume: 'native-session',
  interrupt: 'graceful-ack',
  approvals: 'interactive',
  // `claude --help` (2.1.310): "an alias for the latest model (e.g. 'fable',
  // 'opus', or 'sonnet') or a model's full name".
  models: { discovery: 'none', aliases: ['fable', 'opus', 'sonnet'], passthrough: true },
  maxContextTokens: null,
  usage: { cost: 'reported', cacheSplit: true, reasoning: true, semantics: 'delta-per-turn' },
  isolation: 'sandbox-provider-process',
  minVersion: MIN_CLAUDE_CODE_VERSION_TEXT,
};

/** Tools pre-approved under the `allow` policy (the OS sandbox is the boundary). */
const ALLOW_POLICY_TOOLS = 'Bash,Edit,Write,NotebookEdit';

export function permissionArgs(policy: PermissionPolicy): string[] {
  if (policy.default === 'ask') return ['--permission-prompt-tool', 'stdio'];
  if (policy.default === 'deny') return ['--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
  return ['--permission-mode', 'acceptEdits', '--allowedTools', ALLOW_POLICY_TOOLS, '--permission-prompts', 'none'];
}

export interface ClaudeArgsInput {
  systemContract?: string;
  sessionId?: string;
  resumeId?: string;
  model?: string;
  maxTurns?: number;
  maxUsd?: number;
  permissions: PermissionPolicy;
}

export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--input-format', 'stream-json',
    // Repository settings (hooks, env, apiKeyHelper) and .mcp.json are
    // agent-controlled content; like OPENCODE_DISABLE_PROJECT_CONFIG.
    '--setting-sources', 'user',
    '--strict-mcp-config',
  ];
  if (input.systemContract) args.push('--append-system-prompt', input.systemContract);
  if (input.resumeId) args.push('--resume', input.resumeId);
  else if (input.sessionId) args.push('--session-id', input.sessionId);
  if (input.model) args.push('--model', input.model);
  if (input.maxTurns && Number.isInteger(input.maxTurns) && input.maxTurns > 0) args.push('--max-turns', String(input.maxTurns));
  if (input.maxUsd && Number.isFinite(input.maxUsd) && input.maxUsd > 0) args.push('--max-budget-usd', String(input.maxUsd));
  args.push(...permissionArgs(input.permissions));
  return args;
}

function httpsHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    return url.port && url.port !== '443' ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return null;
  }
}

export interface ClaudeCodeRunnerOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  resolveBinary?: () => ClaudeBinary | null;
  launch?: (spec: RunnerProcessSpec) => Promise<RunnerProcess>;
  runCommand?: typeof runShortCommand;
  newSessionId?: () => string;
  killGraceMs?: number;
  interruptAckMs?: number;
  healthTtlMs?: number;
}

interface RunInput {
  worktree: string;
  prompt: string;
  systemContract?: string;
  model?: string;
  permissions: PermissionPolicy;
  env: Record<string, string>;
  maxTurns?: number;
  maxUsd?: number;
  sessionId?: string;
  resumeId?: string;
}

export class ClaudeCodeRunner implements AgentRunner {
  readonly id = 'claude-code' as const;
  readonly capabilities = CAPABILITIES;
  readonly features = FEATURES;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly resolveBinary: () => ClaudeBinary | null;
  private readonly launch: (spec: RunnerProcessSpec) => Promise<RunnerProcess>;
  private readonly runCommand: typeof runShortCommand;
  private readonly versions = new Map<string, string | null>();
  private health: { at: number; value: RunnerHealth } | null = null;

  constructor(private readonly options: ClaudeCodeRunnerOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.resolveBinary = options.resolveBinary ?? (() => resolveClaudeBinary(this.env));
    this.launch = options.launch ?? ((spec) => launchRunnerProcess(spec, { env: this.env, platform: this.platform }));
    this.runCommand = options.runCommand ?? runShortCommand;
  }

  /** Env for host-side, non-inference status commands (the user's own login). */
  private hostEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
    return buildRunnerProcessEnv(this.env, { CLAUDE_CONFIG_DIR: this.env.CLAUDE_CONFIG_DIR, ...extra });
  }

  private async version(binary: ClaudeBinary): Promise<string | null> {
    if (this.versions.has(binary.path)) return this.versions.get(binary.path) ?? null;
    const result = await this.runCommand(binary.path, ['--version'], { env: this.hostEnv(), timeoutMs: 10_000 });
    const parsed = result.code === 0 ? parseSemver(result.stdout) : null;
    const text = parsed ? parsed.join('.') : null;
    this.versions.set(binary.path, text);
    return text;
  }

  async healthCheck(): Promise<RunnerHealth> {
    const ttl = this.options.healthTtlMs ?? 60_000;
    if (this.health && Date.now() - this.health.at < ttl) return this.health.value;
    const value = await this.checkHealth();
    this.health = { at: Date.now(), value };
    return value;
  }

  private async checkHealth(): Promise<RunnerHealth> {
    const binary = this.resolveBinary();
    if (!binary) {
      return { ok: false, detail: 'Claude Code (`claude`) was not found; install it or set OPENLINEAR_CLAUDE_PATH' };
    }
    const version = await this.version(binary);
    if (!version) return { ok: false, binary: binary.path, detail: '`claude --version` failed' };
    if (!semverAtLeast(parseSemver(version), MIN_CLAUDE_CODE_VERSION)) {
      return { ok: false, binary: binary.path, version, detail: `Claude Code ${version} is older than the supported minimum ${MIN_CLAUDE_CODE_VERSION_TEXT}; run \`claude update\`` };
    }
    const auth = await this.authStatus(binary);
    return {
      ok: auth.status === 'ok',
      binary: binary.path,
      version,
      auth,
      detail: [`Claude Code ${version} (${binary.source})`, auth.detail, 'Execution is not checked (no inference).'].filter(Boolean).join('; '),
    };
  }

  /**
   * `claude auth status --json` on the host: reads the CLI's own login state
   * and reports it without any model request. Only non-identifying fields
   * are kept (the output also carries email and organization).
   */
  private async authStatus(binary: ClaudeBinary): Promise<RunnerAuthStatus> {
    const result = await this.runCommand(binary.path, ['auth', 'status', '--json'], { env: this.hostEnv(), timeoutMs: 15_000 });
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(result.stdout) as unknown;
      parsed = isRecord(value) ? value : null;
    } catch {
      parsed = null;
    }
    if (!parsed) return { status: 'unknown', detail: '`claude auth status --json` returned no status' };
    const rawMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined;
    const method = rawMethod && /^[A-Za-z0-9._-]{1,32}$/.test(rawMethod) ? rawMethod : undefined;
    if (parsed.loggedIn !== true) {
      return { status: 'missing', ...(method ? { method } : {}), detail: 'Claude Code is not logged in (run `claude auth login`), and no ANTHROPIC_API_KEY is passed per run' };
    }
    let mode: 'enforce' | 'trusted-host' = 'enforce';
    try {
      mode = resolveSandboxMode(this.env).mode;
    } catch {
      mode = 'enforce';
    }
    if (mode === 'trusted-host') return { status: 'ok', ...(method ? { method } : {}), detail: `logged in (${method ?? 'unknown method'}); trusted-host grant` };
    if (parsed.apiProvider !== undefined && parsed.apiProvider !== 'firstParty') {
      return { status: 'unreachable-in-sandbox', ...(method ? { method } : {}), detail: 'Cloud-provider credentials are not passed into the agent sandbox' };
    }
    if (existsSync(claudeCredentialsFile(this.env))) {
      return { status: 'ok', ...(method ? { method } : {}), detail: `logged in (${method ?? 'unknown method'}); login file readable read-only in the sandbox` };
    }
    return {
      status: 'unreachable-in-sandbox',
      ...(method ? { method } : {}),
      detail: this.platform === 'darwin'
        ? 'Logged in through the macOS Keychain, which the agent sandbox deliberately does not expose; pass ANTHROPIC_API_KEY per run or use a trusted-host grant'
        : 'Logged in, but not through a credentials file the agent sandbox can read; pass ANTHROPIC_API_KEY per run or use a trusted-host grant',
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // No non-inference discovery is used; aliases are advertised in `features`.
    return [];
  }

  async start(input: StartInput): Promise<AgentSession> {
    const sessionId = (this.options.newSessionId ?? randomUUID)();
    const session = new ClaudeCodeSession({
      sessionId,
      resumed: false,
      model: input.model,
      worktree: input.worktreePath,
      permissions: input.permissions,
      signal: input.signal,
      env: this.env,
      killGraceMs: this.options.killGraceMs,
      interruptAckMs: this.options.interruptAckMs,
    });
    if (input.signal.aborted) {
      session.notStarted();
      return session;
    }
    const proc = await this.launchRun({
      worktree: input.worktreePath,
      prompt: input.prompt,
      systemContract: input.systemContract,
      model: claudeModelArg(input.model),
      permissions: input.permissions,
      env: input.env,
      maxTurns: input.budgets.maxTurns,
      maxUsd: input.budgets.maxUsd,
      sessionId,
    });
    session.begin(proc, input.prompt);
    return session;
  }

  async resume(externalSessionId: string, input: ResumeInput): Promise<AgentSession> {
    const permissions = input.permissions ?? { default: 'allow' };
    const session = new ClaudeCodeSession({
      sessionId: externalSessionId,
      resumed: true,
      model: input.model,
      worktree: input.worktreePath,
      permissions,
      signal: input.signal,
      env: this.env,
      killGraceMs: this.options.killGraceMs,
      interruptAckMs: this.options.interruptAckMs,
    });
    if (input.signal.aborted) {
      session.notStarted();
      return session;
    }
    const prompt = input.prompt ?? RESUME_CONTINUATION_PROMPT;
    const proc = await this.launchRun({
      worktree: input.worktreePath,
      prompt,
      model: claudeModelArg(input.model),
      permissions,
      env: input.env ?? {},
      resumeId: externalSessionId,
    });
    session.begin(proc, prompt);
    return session;
  }

  /**
   * How the sandboxed CLI authenticates, decided before anything is spawned:
   * 1. an Anthropic API key passed explicitly for this run, else
   * 2. the user's own file-based login (Linux; macOS Keychain fallback),
   *    linked read-only, else
   * 3. under trusted-host, the unmodified CLI with its own HOME/Keychain.
   * A Keychain-only login under the enforced sandbox fails closed.
   */
  private loginPlan(apiKey: string | undefined): LoginFileAllowance[] {
    if (apiKey) return [];
    const mode = resolveSandboxMode(this.env).mode;
    if (mode === 'trusted-host') return [];
    const source = claudeCredentialsFile(this.env);
    if (existsSync(source)) return [{ source, linkName: '.credentials.json' }];
    throw new RunnerAuthUnavailableError(
      'claude-code',
      this.platform === 'darwin'
        ? 'Claude Code keeps this login in the macOS Keychain, which the agent sandbox does not expose. Pass an Anthropic API key for the run, or run under an explicit trusted-host grant.'
        : 'No Claude Code login file is available to the agent sandbox. Run `claude auth login`, pass an Anthropic API key for the run, or run under an explicit trusted-host grant.',
      { credentialsFile: source },
    );
  }

  private async usableBinary(): Promise<ClaudeBinary> {
    const binary = this.resolveBinary();
    if (!binary) throw new RunnerUnavailableError('claude-code', 'Claude Code (`claude`) was not found; install it or set OPENLINEAR_CLAUDE_PATH');
    const version = await this.version(binary);
    if (!semverAtLeast(parseSemver(version ?? ''), MIN_CLAUDE_CODE_VERSION)) {
      throw new RunnerUnavailableError('claude-code', `Claude Code ${version ?? '(unknown version)'} is not supported; ${MIN_CLAUDE_CODE_VERSION_TEXT} or newer is required`, { version });
    }
    return binary;
  }

  /**
   * W07a run-engine hook: everything `start` would refuse before spawning —
   * binary, minimum version, and a credential the sandboxed CLI can reach —
   * checked without spawning anything, so a run engine can fail an
   * unsupported combination before it journals or dispatches any effect.
   * Throws RUNNER_UNAVAILABLE (503) / RUNNER_AUTH_UNAVAILABLE (412).
   */
  async preflight(input: { env: Record<string, string> }): Promise<void> {
    await this.usableBinary();
    this.loginPlan(input.env.ANTHROPIC_API_KEY || undefined);
  }

  /**
   * W07a run-engine hook: whether `--resume <sessionId>` can continue a saved
   * session for `worktree` — the transcript must exist in the config dir a
   * launch for that worktree uses (the private runtime dir under enforce,
   * the user's own config dir under a trusted-host grant).
   */
  canResume(sessionId: string, worktree: string): boolean {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return false;
    let mode: 'enforce' | 'trusted-host' = 'enforce';
    try {
      mode = resolveSandboxMode(this.env).mode;
    } catch {
      return false;
    }
    const configDir = mode === 'trusted-host'
      ? (this.env.CLAUDE_CONFIG_DIR ?? join(this.env.HOME ?? homedir(), '.claude'))
      : runnerRuntimeDir('claude-code', worktree, this.env, this.platform);
    if (!configDir) return false;
    return findSessionFile(join(configDir, 'projects'), (name) => name === `${sessionId}.jsonl`, 1);
  }

  private async launchRun(run: RunInput): Promise<RunnerProcess> {
    const binary = await this.usableBinary();
    const apiKey = run.env.ANTHROPIC_API_KEY || undefined;
    const baseHost = httpsHost(run.env.ANTHROPIC_BASE_URL);
    const baseUrl = baseHost ? run.env.ANTHROPIC_BASE_URL : undefined;
    const loginFiles = this.loginPlan(apiKey);
    const egressHosts = [
      // OAuth refresh/profile for a subscription login.
      ...(loginFiles.length > 0 ? ['platform.claude.com'] : []),
      ...(baseHost ? [baseHost] : []),
    ];
    const runtimeEnv = {
      DISABLE_AUTOUPDATER: '1',
      // One prompt → one result: no background work that would start
      // further turns after the result.
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_BASE_URL: baseUrl,
    };
    const args = buildClaudeArgs({
      systemContract: run.systemContract,
      sessionId: run.sessionId,
      resumeId: run.resumeId,
      model: run.model,
      maxTurns: run.maxTurns,
      maxUsd: run.maxUsd,
      permissions: run.permissions,
    });
    return this.launch({
      runner: 'claude-code',
      worktree: run.worktree,
      binary: binary.path,
      argv: () => args,
      enforceEnv: (dirs) => ({
        ...runtimeEnv,
        // Private config dir: transcripts for resume, no access to the
        // user's other projects, no persistent settings/hooks outside.
        CLAUDE_CONFIG_DIR: dirs.runtime,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }),
      hostEnv: () => this.hostEnv(runtimeEnv),
      readRoots: binary.readRoot ? [binary.readRoot] : [],
      loginFiles,
      egressProviders: ['anthropic'],
      egressHosts,
    });
  }
}
