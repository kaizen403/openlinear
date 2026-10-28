import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type AgentEvent, type AgentRunner, type AgentSession, reduceUsage, type StartInput } from '@openlinear/execution-core';
import type { Termination } from '../grading/outcome';
import type { TimedEvent } from '../trajectory/types';
import type { RawUsage } from '../usage/cost';
import { semanticsForRunner, terminationForErrorCode } from './classify';
import { type FeatureSupport, firstActionMs, type HarnessRunner, type RunnerResult, type TrialContext } from './types';

/**
 * OpenLinear in the loop, adapter transport: the task is driven through an
 * execution-core `AgentRunner` exactly as the sidecar run engine drives it —
 * system contract + prompt + budgets + permission policy in `StartInput`,
 * the event stream consumed to a single terminal, cancellation through
 * interrupt → abort with a confirmed receipt, usage via `reduceUsage`.
 *
 * The runner is injected: a real sidecar adapter (OpenCode / Claude Code /
 * Codex under the verified sandbox, see `adapter-loader.ts`) for funded runs,
 * or `ReplayAgentRunner` for offline FAKE runs. This transport excludes the
 * HTTP control plane (attempts, capabilities, publication); the `api`
 * transport covers that path.
 */

export interface OpenLinearAdapterRunnerOptions {
  runner: AgentRunner;
  /** True when `runner` replays recordings (reported on every result). */
  fake: boolean;
  /** Per-run provider credentials (StartInput.env). Never logged or recorded. */
  credentials?: () => Record<string, string>;
  /** After the wall-clock budget: interrupt, then abort after this grace, then give up after the same grace. */
  stopGraceMs?: number;
}

export class OpenLinearAdapterRunner implements HarnessRunner {
  readonly kind = 'openlinear-adapter';
  /** The harness writes the prompt, and every trial phase is its own session (review: deny policy). */
  readonly featureSupport: FeatureSupport = { promptSections: true, reviewPhases: true };
  private version: Promise<string | null> | null = null;

  constructor(private readonly options: OpenLinearAdapterRunnerOptions) {}

  private runnerVersion(): Promise<string | null> {
    this.version ??= this.options.runner
      .healthCheck()
      .then((health) => health.version ?? null)
      .catch(() => null);
    return this.version;
  }

  async run(ctx: TrialContext): Promise<RunnerResult> {
    const { configuration, manifest } = ctx;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    ctx.signal.addEventListener('abort', onOuterAbort, { once: true });
    const home = join(ctx.scratchDir, 'home');
    await mkdir(home, { recursive: true });
    // A reviewer session reads only (W19a: deny policy, as the sidecar's reviewer); the cap is what is left of the task's.
    const maxUsd = ctx.budgetUsd !== undefined ? ctx.budgetUsd : manifest.budgets.maxUsdPerTask;
    const input: StartInput = {
      runId: ctx.trialId,
      worktreePath: ctx.worktree,
      systemContract: ctx.systemContract,
      prompt: ctx.prompt,
      model: { provider: configuration.model.provider, id: configuration.model.snapshot || configuration.model.requested },
      budgets: {
        wallClockMs: manifest.budgets.agentTimeoutMs,
        ...(manifest.budgets.maxTurns !== null ? { maxTurns: manifest.budgets.maxTurns } : {}),
        ...(manifest.budgets.maxTokensPerTask !== null ? { maxTokens: manifest.budgets.maxTokensPerTask } : {}),
        ...(maxUsd !== null ? { maxUsd } : {}),
      },
      permissions: { default: ctx.phase === 'review' ? 'deny' : 'allow' },
      sandbox: { cwd: ctx.worktree, env: manifest.sandbox.privateHome ? { HOME: home } : {} },
      env: this.options.credentials?.() ?? {},
      signal: controller.signal,
    };
    const logs: string[] = [];
    const events: TimedEvent[] = [];
    const started = Date.now();
    const result = (termination: Termination, terminationDetail: string): RunnerResult => {
      const plain: AgentEvent[] = events.map((timed) => timed.event);
      const sawUsage = plain.some((event) => event.t === 'usage');
      const reduced = reduceUsage(plain);
      const costEvents = plain.filter((event): event is Extract<AgentEvent, { t: 'usage' }> => event.t === 'usage' && event.cost !== undefined);
      const usage: RawUsage = {
        tokens: sawUsage ? reduced.usage : null,
        tokenBasis: sawUsage ? 'provider-reported' : 'unknown',
        semantics: sawUsage ? semanticsForRunner(configuration.runner.id) : 'unknown',
        reportedCostUsd: costEvents.length > 0 ? reduced.costUsd : null,
        reportedCostBasis: costEvents.length > 0 ? 'runner-reported' : null,
        reportedCostSource: costEvents[0]?.cost?.basis ?? (costEvents.length > 0 ? `${configuration.runner.id} usage event` : null),
      };
      const session = plain.find((event): event is Extract<AgentEvent, { t: 'session.started' }> => event.t === 'session.started');
      return {
        termination,
        terminationDetail,
        events,
        nativeLines: [],
        usage,
        agentMs: Date.now() - started,
        firstActionMs: firstActionMs(events),
        observedModel: session?.model.id ?? null,
        observedRunnerVersion: null,
        invocation: null,
        logs,
      };
    };

    let session: AgentSession;
    try {
      session = await this.options.runner.start(input);
    } catch (error) {
      ctx.signal.removeEventListener('abort', onOuterAbort);
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'RUNNER_START_FAILED';
      logs.push(`runner start failed: ${code}: ${error instanceof Error ? error.message : String(error)}`);
      const termination = terminationForErrorCode(code);
      const out = result(termination === 'agent-error' ? 'infra' : termination, `start failed (${code})`);
      out.observedRunnerVersion = await this.runnerVersion();
      out.startErrorCode = code;
      return out;
    }

    const grace = this.options.stopGraceMs ?? 5000;
    let timedOut = false;
    let gaveUp = false;
    let giveUp: (() => void) | null = null;
    const gaveUpSignal = new Promise<'gave-up'>((resolve) => {
      giveUp = () => resolve('gave-up');
    });
    const timers: NodeJS.Timeout[] = [];
    timers.push(
      setTimeout(() => {
        timedOut = true;
        logs.push(`wall-clock budget ${manifest.budgets.agentTimeoutMs} ms elapsed: interrupt`);
        void session.interrupt().catch(() => undefined);
        timers.push(
          setTimeout(() => {
            logs.push('no terminal after interrupt: abort');
            void session.abort().catch(() => undefined);
            timers.push(
              setTimeout(() => {
                gaveUp = true;
                logs.push('no terminal after abort: stop unconfirmed, giving up on the stream');
                giveUp?.();
              }, grace),
            );
          }, grace),
        );
      }, manifest.budgets.agentTimeoutMs),
    );

    let terminal: Extract<AgentEvent, { t: 'turn.finished' }> | null = null;
    let lastError: Extract<AgentEvent, { t: 'error' }> | null = null;
    const iterator = session.events[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), gaveUpSignal]);
        if (next === 'gave-up' || next.done) break;
        const event = next.value;
        events.push({ atMs: Date.now() - started, event });
        if (event.t === 'permission.requested') {
          // No human in the loop: anything outside the start policy is denied, identically for every configuration.
          logs.push(`permission requested (${event.tool}); denied by eval policy`);
          await session.replyPermission(event.id, 'deny').catch(() => undefined);
        }
        if (event.t === 'error') lastError = event;
        if (event.t === 'turn.finished') {
          terminal = event;
          break;
        }
      }
    } catch (error) {
      logs.push(`event stream threw: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onOuterAbort);
      if (!gaveUp) await iterator.return?.().catch(() => undefined);
    }

    let out: RunnerResult;
    // A runtime that cannot be confirmed stopped may still be editing the worktree: its artifacts
    // cannot be snapshotted reliably, so this is a platform (infra) failure, not an agent timeout.
    if (gaveUp) out = result('infra', 'wall-clock budget elapsed and the stop was never confirmed (cancel_unconfirmed); artifacts not trustworthy');
    else if (timedOut) out = result('timeout', 'wall-clock budget');
    else if (ctx.signal.aborted) out = result('cancelled', 'harness cancelled the trial');
    else if (terminal === null) out = result('agent-error', 'stream ended without a terminal event');
    else if (terminal.reason === 'idle') out = result('completed', 'idle');
    else if (terminal.reason === 'max_turns') out = result('budget', 'max_turns');
    else if (terminal.reason === 'interrupted') out = result('agent-error', 'interrupted without a harness request');
    else out = result(terminationForErrorCode(lastError?.code ?? null), lastError ? `${lastError.code}: ${lastError.message}` : 'error');
    out.observedRunnerVersion = await this.runnerVersion();
    return out;
  }
}
