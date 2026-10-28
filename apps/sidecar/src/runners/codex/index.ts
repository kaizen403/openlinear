import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEvent,
  AgentRunner,
  AgentSession,
  ModelDescriptor,
  ModelRef,
  ResumeInput,
  RunnerAuthStatus,
  RunnerCapabilities,
  RunnerFeatures,
  RunnerHealth,
  StartInput,
  TokenUsage,
} from '@openlinear/execution-core';
import { emptyTokenUsage } from '@openlinear/execution-core';
import type { ThreadEvent } from '@openai/codex-sdk';
import { buildRunnerProcessEnv } from '../../sandbox/env';
import { resolveSandboxMode } from '../../sandbox/mode';
import { runShortCommand } from '../shared/binary';
import { RESUME_CONTINUATION_PROMPT } from '../shared/continuation';
import { isRecord } from '../shared/jsonl';
import type { ExitInfo } from '../shared/process-group';
import { RunnerAuthUnavailableError, RunnerUnavailableError } from '../shared/errors';
import { ProcessAgentSession } from '../shared/process-session';
import { findSessionFile, launchRunnerProcess, runnerRuntimeDir, type RunnerProcess, type RunnerProcessSpec } from '../shared/sandboxed-process';
import { buildCodexExecArgs, CODEX_SDK_VERSION, resolveCodexBinary, type CodexBinary } from './exec';

const CAPABILITIES: RunnerCapabilities = {
  streamingDeltas: true,
  reasoningDeltas: true,
  permissionReply: false,
  interrupt: true,
  compact: false,
  revert: false,
  fork: false,
  cacheSplitUsage: true,
};

const FEATURES: RunnerFeatures = {
  resume: 'native-session',
  // `codex exec` has no in-band interrupt; app-server's turn/interrupt is not used.
  interrupt: 'process-abort',
  approvals: 'policy-only',
  models: { discovery: 'none', aliases: [], passthrough: true },
  maxContextTokens: null,
  usage: { cost: 'none', cacheSplit: true, reasoning: true, semantics: 'delta-per-turn' },
  isolation: 'sandbox-provider-process',
};

/** Event types of `ThreadEvent` in @openai/codex-sdk 0.164.0 (unchanged since 0.147.0). */
const KNOWN_EVENT_TYPES = new Set<string>([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
]);

export interface CodexEventState {
  externalId?: string;
  textByItem: Map<string, string>;
  startedTools: Set<string>;
  completedItems: Set<string>;
  usage: TokenUsage;
  turn: number;
  terminal: boolean;
}

export function createEventState(): CodexEventState {
  return {
    textByItem: new Map(),
    startedTools: new Set(),
    completedItems: new Set(),
    usage: emptyTokenUsage(),
    turn: 0,
    terminal: false,
  };
}

function textDelta(state: CodexEventState, key: string, next: string): string {
  const previous = state.textByItem.get(key) ?? '';
  if (next === previous || previous.startsWith(next)) return '';
  state.textByItem.set(key, next);
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

export function decodeCodexEvent(
  event: ThreadEvent,
  state: CodexEventState,
  model: ModelRef = { provider: 'openai', id: 'unknown' },
): AgentEvent[] {
  if (state.terminal) return [];
  const out: AgentEvent[] = [];
  switch (event.type) {
    case 'thread.started':
      if (state.externalId !== event.thread_id) {
        state.externalId = event.thread_id;
        out.push({ t: 'session.started', externalId: event.thread_id, model });
      }
      break;
    case 'turn.started':
      state.turn += 1;
      out.push({ t: 'turn.started', turn: state.turn });
      break;
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = event.item;
      if (state.completedItems.has(item.id)) break;
      if (item.type === 'agent_message' || item.type === 'reasoning') {
        const delta = textDelta(state, item.id, item.text);
        if (delta) out.push({ t: item.type === 'agent_message' ? 'message.delta' : 'reasoning.delta', text: delta });
      }
      if (item.type === 'command_execution') {
        if (!state.startedTools.has(item.id)) {
          state.startedTools.add(item.id);
          out.push({ t: 'tool.started', callId: item.id, name: 'bash', input: { command: item.command } });
        }
        const previous = state.textByItem.get(item.id) ?? '';
        const chunk = textDelta(state, item.id, item.aggregated_output);
        if (chunk) {
          out.push({
            t: 'tool.output', callId: item.id, chunk,
            cumulative: !item.aggregated_output.startsWith(previous),
          });
        }
        if (event.type === 'item.completed') {
          out.push({
            t: 'tool.finished', callId: item.id, name: 'bash',
            ok: item.status === 'completed' && (item.exit_code === undefined || item.exit_code === 0),
            summary: item.aggregated_output,
          });
        }
      }
      if (item.type === 'mcp_tool_call') {
        const name = `${item.server}.${item.tool}`;
        if (!state.startedTools.has(item.id)) {
          state.startedTools.add(item.id);
          out.push({ t: 'tool.started', callId: item.id, name, input: item.arguments });
        }
        if (event.type === 'item.completed') {
          out.push({
            t: 'tool.finished', callId: item.id, name,
            ok: item.status === 'completed' && !item.error,
            summary: item.error?.message ?? (item.result ? JSON.stringify(item.result) : undefined),
          });
        }
      }
      if (item.type === 'file_change' && event.type === 'item.completed') {
        // W07 conformance: every tool.finished follows its tool.started.
        if (!state.startedTools.has(item.id)) {
          state.startedTools.add(item.id);
          out.push({ t: 'tool.started', callId: item.id, name: 'apply_patch', input: { changes: item.changes } });
        }
        out.push({ t: 'tool.finished', callId: item.id, name: 'apply_patch', ok: item.status === 'completed' });
        if (item.status === 'completed') {
          for (const change of item.changes) {
            out.push({
              t: 'file.changed', path: change.path,
              kind: change.kind === 'add' ? 'create' : change.kind === 'delete' ? 'delete' : 'edit',
            });
          }
        }
      }
      if (item.type === 'error' && event.type === 'item.completed') {
        if (!state.startedTools.has(item.id)) {
          state.startedTools.add(item.id);
          out.push({ t: 'tool.started', callId: item.id, name: 'codex', input: {} });
        }
        out.push({ t: 'tool.finished', callId: item.id, name: 'codex', ok: false, summary: item.message });
      }
      if (event.type === 'item.completed') state.completedItems.add(item.id);
      break;
    }
    case 'turn.completed':
      state.usage = {
        input: event.usage.input_tokens,
        output: event.usage.output_tokens,
        cacheRead: event.usage.cached_input_tokens,
        cacheWrite: event.usage.cache_write_input_tokens,
        reasoning: event.usage.reasoning_output_tokens,
      };
      out.push({ t: 'usage', usage: state.usage });
      out.push({ t: 'turn.finished', turn: state.turn, reason: 'idle' });
      state.terminal = true;
      break;
    case 'turn.failed':
    case 'error':
      out.push({
        t: 'error',
        code: 'codex',
        message: event.type === 'error' ? event.message : event.error.message,
        retryable: false,
      });
      out.push({ t: 'turn.finished', turn: state.turn, reason: 'error' });
      state.terminal = true;
      break;
  }
  return out;
}

/** The SDK backfills `cache_write_input_tokens` for older CLIs; so do we. */
function normalizeThreadEvent(value: Record<string, unknown>): ThreadEvent {
  if (value.type === 'turn.completed' && isRecord(value.usage) && value.usage.cache_write_input_tokens === undefined) {
    return { ...value, usage: { ...value.usage, cache_write_input_tokens: 0 } } as unknown as ThreadEvent;
  }
  return value as unknown as ThreadEvent;
}

export class CodexSession extends ProcessAgentSession {
  private readonly state = createEventState();
  private readonly reportedTypes = new Set<string>();

  constructor(
    private readonly initialId: string,
    private readonly model: ModelRef | undefined,
    signal: AbortSignal,
    killGraceMs?: number,
  ) {
    super({ signal, killGraceMs });
  }

  get externalId(): string {
    // A new thread receives its resumable id only with thread.started.
    return this.state.externalId ?? this.initialId;
  }

  /** The sandbox the CLI runs under (W09a metadata), once started. */
  get sandbox() {
    return this.proc?.metadata ?? null;
  }

  /**
   * W07a: the process is attached now; the prompt goes to stdin (then EOF)
   * when the event stream is first consumed, so nothing is submitted before
   * the consumer is ready to journal it.
   */
  begin(proc: RunnerProcess, prompt: string, resumedThreadId: string | null): void {
    this.attach(proc);
    if (resumedThreadId) this.dispatch({ type: 'thread.started', thread_id: resumedThreadId });
    this.deferUntilConsumed(() => {
      proc.stdin.write(prompt);
      this.closeStdin();
    });
  }

  notStarted(): void {
    this.finishNotStarted('signal');
  }

  protected onMessage(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== 'string') {
      this.reportLine('unknown_event', 'Ignored a Codex line without an event type');
      return;
    }
    if (!KNOWN_EVENT_TYPES.has(value.type)) {
      if (!this.reportedTypes.has(value.type)) {
        this.reportedTypes.add(value.type);
        this.emit({ t: 'diagnostic', code: 'unknown_event', message: `Ignored unknown Codex event type ${value.type}` });
      }
      return;
    }
    this.dispatch(normalizeThreadEvent(value));
  }

  private dispatch(event: ThreadEvent): void {
    const decoded = decodeCodexEvent(event, this.state, this.model);
    this.turn = this.state.turn;
    const terminalIndex = decoded.findIndex((item) => item.t === 'turn.finished');
    if (terminalIndex === -1) {
      for (const item of decoded) this.emit(item);
      return;
    }
    const terminal = decoded[terminalIndex];
    const reason = terminal.t === 'turn.finished' ? terminal.reason : 'error';
    this.finish(decoded.slice(0, terminalIndex), reason);
  }

  protected eofFailure(_exit: ExitInfo): { code: string; message: string } {
    return { code: 'codex', message: 'Codex stream closed before the turn ended' };
  }
}

export interface CodexRunnerOptions {
  env?: NodeJS.ProcessEnv;
  resolveBinary?: () => CodexBinary;
  launch?: (spec: RunnerProcessSpec) => Promise<RunnerProcess>;
  runCommand?: typeof runShortCommand;
  killGraceMs?: number;
  healthTtlMs?: number;
}

/** Codex's own login file under CODEX_HOME (default ~/.codex). */
function codexAuthFile(env: NodeJS.ProcessEnv): string {
  return join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'), 'auth.json');
}

export class CodexRunner implements AgentRunner {
  readonly id = 'codex' as const;
  readonly capabilities = CAPABILITIES;
  readonly features = FEATURES;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolveBinary: () => CodexBinary;
  private readonly launch: (spec: RunnerProcessSpec) => Promise<RunnerProcess>;
  private readonly runCommand: typeof runShortCommand;
  private health: { at: number; value: RunnerHealth } | null = null;

  constructor(private readonly options: CodexRunnerOptions = {}) {
    this.env = options.env ?? process.env;
    this.resolveBinary = options.resolveBinary ?? (() => resolveCodexBinary(this.env));
    this.launch = options.launch ?? ((spec) => launchRunnerProcess(spec, { env: this.env }));
    this.runCommand = options.runCommand ?? runShortCommand;
  }

  async healthCheck(): Promise<RunnerHealth> {
    const ttl = this.options.healthTtlMs ?? 60_000;
    if (this.health && Date.now() - this.health.at < ttl) return this.health.value;
    const value = await this.checkHealth();
    this.health = { at: Date.now(), value };
    return value;
  }

  private async checkHealth(): Promise<RunnerHealth> {
    let binary: CodexBinary;
    try {
      binary = this.resolveBinary();
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'codex unavailable' };
    }
    const env = buildRunnerProcessEnv(this.env);
    const version = await this.runCommand(binary.path, ['--version'], { env, timeoutMs: 10_000 });
    const versionText = /codex-cli\s+(\S+)/.exec(version.stdout)?.[1];
    if (version.code !== 0 || !versionText) {
      return { ok: false, binary: binary.path, detail: `codex --version failed${version.timedOut ? ' (timed out)' : ''}` };
    }
    const auth = await this.authStatus(binary, env);
    const sdkMatch = binary.version === null || binary.version === CODEX_SDK_VERSION;
    return {
      ok: auth.status === 'ok',
      version: versionText,
      binary: binary.path,
      auth,
      detail: [
        `codex-cli ${versionText} (${binary.source}${sdkMatch ? '' : `, SDK types pinned to ${CODEX_SDK_VERSION}`})`,
        auth.detail,
        'Execution is not checked (no inference).',
      ].filter(Boolean).join('; '),
    };
  }

  /** `codex login status` on the host; only the method is kept (it prints a masked key). */
  private async authStatus(binary: CodexBinary, env: Record<string, string>): Promise<RunnerAuthStatus> {
    const status = await this.runCommand(binary.path, ['login', 'status'], { env, timeoutMs: 10_000 });
    const first = `${status.stdout}\n${status.stderr}`.trim().split('\n')[0] ?? '';
    let method: string | undefined;
    if (/chatgpt/i.test(first)) method = 'chatgpt';
    else if (/api key/i.test(first)) method = 'api-key';
    else if (/access token/i.test(first)) method = 'access-token';
    if (!method || /not logged in/i.test(first)) {
      return { status: 'missing', detail: 'Codex is not logged in (run `codex login`), and no OPENAI_API_KEY is passed per run' };
    }
    let mode: 'enforce' | 'trusted-host' = 'enforce';
    try {
      mode = resolveSandboxMode(this.env).mode;
    } catch {
      mode = 'enforce';
    }
    if (mode === 'enforce' && !existsSync(codexAuthFile(this.env))) {
      return {
        status: 'unreachable-in-sandbox',
        method,
        detail: 'Codex is logged in, but not through CODEX_HOME/auth.json (e.g. a keyring), which the agent sandbox cannot read; pass OPENAI_API_KEY per run or use a trusted-host grant',
      };
    }
    return { status: 'ok', method, detail: `logged in (${method})` };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // `codex exec` has no model discovery; account-aware discovery belongs to another surface.
    return [];
  }

  /**
   * W07a run-engine hook: what `start` needs, checked without spawning —
   * the CLI binary, and a credential the sandboxed CLI can reach (a per-run
   * key, or Codex's own login file; a keyring login is unreachable under
   * the enforced sandbox). Throws RUNNER_UNAVAILABLE (503) /
   * RUNNER_AUTH_UNAVAILABLE (412).
   */
  async preflight(input: { env: Record<string, string> }): Promise<void> {
    try {
      this.resolveBinary();
    } catch (err) {
      throw new RunnerUnavailableError('codex', err instanceof Error ? err.message : 'The Codex CLI is unavailable');
    }
    if (input.env.OPENAI_API_KEY || input.env.CODEX_API_KEY) return;
    let mode: 'enforce' | 'trusted-host' = 'enforce';
    try {
      mode = resolveSandboxMode(this.env).mode;
    } catch {
      mode = 'enforce';
    }
    if (mode === 'enforce' && !existsSync(codexAuthFile(this.env))) {
      throw new RunnerAuthUnavailableError(
        'codex',
        'No Codex login file is available to the agent sandbox (a keyring login is not exposed). Run `codex login`, pass an OpenAI API key for the run, or run under an explicit trusted-host grant.',
        { credentialsFile: codexAuthFile(this.env) },
      );
    }
  }

  /**
   * W07a run-engine hook: whether `resume <threadId>` can continue a saved
   * thread for `worktree` — its rollout file must exist under the CODEX_HOME
   * a launch for that worktree uses.
   */
  canResume(threadId: string, worktree: string): boolean {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/.test(threadId)) return false;
    let mode: 'enforce' | 'trusted-host' = 'enforce';
    try {
      mode = resolveSandboxMode(this.env).mode;
    } catch {
      return false;
    }
    const home = mode === 'trusted-host'
      ? (this.env.CODEX_HOME ?? join(this.env.HOME ?? homedir(), '.codex'))
      : runnerRuntimeDir('codex', worktree, this.env);
    if (!home) return false;
    return findSessionFile(join(home, 'sessions'), (name) => name.endsWith('.jsonl') && name.includes(threadId), 4);
  }

  async start(input: StartInput): Promise<AgentSession> {
    const session = new CodexSession(input.runId, input.model, input.signal, this.options.killGraceMs);
    if (input.signal.aborted) {
      session.notStarted();
      return session;
    }
    const proc = await this.launch(this.spec({
      worktree: input.worktreePath,
      model: input.model?.id,
      apiKey: input.env.OPENAI_API_KEY ?? input.env.CODEX_API_KEY,
      threadId: null,
    }));
    session.begin(proc, `${input.systemContract}\n\n${input.prompt}`, null);
    return session;
  }

  async resume(externalSessionId: string, input: ResumeInput): Promise<AgentSession> {
    const session = new CodexSession(externalSessionId, input.model, input.signal, this.options.killGraceMs);
    if (input.signal.aborted) {
      session.notStarted();
      return session;
    }
    const proc = await this.launch(this.spec({
      worktree: input.worktreePath,
      model: input.model?.id,
      apiKey: input.env?.OPENAI_API_KEY ?? input.env?.CODEX_API_KEY,
      threadId: externalSessionId,
    }));
    session.begin(proc, input.prompt ?? RESUME_CONTINUATION_PROMPT, externalSessionId);
    return session;
  }

  private spec(args: { worktree: string; model?: string; apiKey?: string; threadId: string | null }): RunnerProcessSpec {
    const binary = this.resolveBinary();
    const withPathDirs = (path: string | undefined) => [...binary.pathDirs, ...(path ? path.split(':') : [])].filter(Boolean).join(':');
    return {
      runner: 'codex',
      worktree: args.worktree,
      binary: binary.path,
      argv: (mode) => buildCodexExecArgs({
        model: args.model,
        // Under the provider our sandbox is the boundary: Codex's own Seatbelt /
        // Landlock cannot nest inside it. Trusted-host keeps Codex's sandbox.
        sandboxMode: mode === 'enforce' ? 'danger-full-access' : 'workspace-write',
        workingDirectory: args.worktree,
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
        threadId: args.threadId,
      }),
      enforceEnv: (dirs, context) => ({
        PATH: withPathDirs(context.path),
        CODEX_HOME: dirs.runtime,
        CODEX_API_KEY: args.apiKey,
      }),
      hostEnv: () => {
        const env = buildRunnerProcessEnv(this.env, { CODEX_API_KEY: args.apiKey });
        env.PATH = withPathDirs(env.PATH);
        return env;
      },
      readRoots: binary.readRoot ? [binary.readRoot] : [],
      // The user's own Codex login, read-only, only when no key is passed.
      loginFiles: args.apiKey ? [] : [{ source: codexAuthFile(this.env), linkName: 'auth.json' }],
      egressProviders: ['openai'],
    };
  }
}
