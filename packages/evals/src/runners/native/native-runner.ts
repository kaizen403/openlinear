import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@openlinear/execution-core';
import type { RecordedTrajectory, TimedEvent } from '../../trajectory/types';
import { baseEnv, runCommand } from '../../util/proc';
import { type FeatureSupport, firstActionMs, type HarnessRunner, type RunnerResult, type TrialContext } from '../types';
import { buildNativeInvocation, DEFAULT_BINARIES, type NativeRunnerId } from './commands';
import { createNativeParser } from './parsers';

/**
 * Native baseline: the vendor CLI invoked directly in the trial worktree,
 * with no OpenLinear code in the loop. Real mode spawns the installed CLI;
 * FAKE mode spawns `replay-cli.mjs`, which prints a recorded stdout protocol
 * and applies recorded edits, so spawning, streaming, parsing, timeouts and
 * process-group cleanup are all exercised offline.
 */

export const REPLAY_CLI_PATH = fileURLToPath(new URL('./replay-cli.mjs', import.meta.url));

export interface NativeRunnerOptions {
  runner: NativeRunnerId;
  mode: 'real' | 'fake';
  /** Real mode: binary to launch (default: the CLI name on PATH). */
  binary?: string;
  /** FAKE mode: recording for a trial. */
  pickRecording?: (context: TrialContext) => RecordedTrajectory;
  /** Real mode: explicit per-run credentials/env for the CLI (never recorded). */
  credentials?: () => Record<string, string>;
  /** Real mode refuses to start unless this is set: real CLIs must run inside an external sandbox. */
  allowRealExecution?: boolean;
  killGraceMs?: number;
}

export class NativeRunnerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeRunnerRefused';
  }
}

export class NativeCliRunner implements HarnessRunner {
  readonly kind: string;
  /**
   * The CLI gets the prompt the harness hands over, so prompt sections apply;
   * a reviewer pass is not wired (it needs a deny-policy session and a
   * follow-up turn through the runner contract — the adapter transport).
   */
  readonly featureSupport: FeatureSupport = { promptSections: true, reviewPhases: false };

  constructor(private readonly options: NativeRunnerOptions) {
    this.kind = `native-${options.runner}${options.mode === 'fake' ? '-replay' : ''}`;
    if (options.mode === 'fake' && !options.pickRecording) throw new Error('FAKE native runner needs pickRecording');
  }

  async run(ctx: TrialContext): Promise<RunnerResult> {
    const { configuration, manifest } = ctx;
    const invocation = buildNativeInvocation({
      runner: this.options.runner,
      binary: this.options.binary ?? DEFAULT_BINARIES[this.options.runner],
      worktree: ctx.worktree,
      prompt: ctx.prompt,
      provider: configuration.model.provider,
      model: configuration.model.snapshot || configuration.model.requested,
      effort: configuration.model.effort,
      maxTurns: manifest.budgets.maxTurns,
      maxUsd: manifest.budgets.maxUsdPerTask,
      disableWebTools: manifest.sandbox.agentNetwork !== 'public',
    });
    const home = join(ctx.scratchDir, 'home');
    await mkdir(home, { recursive: true });
    const credentials = this.options.mode === 'real' ? (this.options.credentials?.() ?? {}) : {};
    const scrub = (text: string) => Object.values(credentials).reduce((acc, secret) => (secret.length >= 8 ? acc.split(secret).join('[redacted]') : acc), text);
    const env = baseEnv({
      HOME: manifest.sandbox.privateHome ? home : (process.env.HOME ?? home),
      TMPDIR: join(ctx.scratchDir),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(home, '.cache'),
      NO_COLOR: '1',
      CI: '1',
      ...credentials,
    });

    let command = invocation.command;
    let args = invocation.args;
    if (this.options.mode === 'fake') {
      const recording = this.options.pickRecording?.(ctx);
      if (!recording?.native) throw new Error(`no native recording for ${ctx.trialId}`);
      const recordingPath = join(ctx.scratchDir, 'recording.json');
      await writeFile(recordingPath, JSON.stringify(recording));
      command = process.execPath;
      args = [REPLAY_CLI_PATH, recordingPath];
    } else if (!this.options.allowRealExecution) {
      throw new NativeRunnerRefused('real native CLIs run only inside an external sandbox (Harbor/container); pass allowRealExecution from a funded-run driver');
    }

    const parser = createNativeParser(invocation.format);
    const events: TimedEvent[] = [];
    const nativeLines: string[] = [];
    const started = Date.now();
    const result = await runCommand(command, args, {
      cwd: ctx.worktree,
      env,
      input: invocation.stdin ?? undefined,
      timeoutMs: manifest.budgets.agentTimeoutMs,
      killGraceMs: this.options.killGraceMs ?? 5000,
      signal: ctx.signal,
      onStdoutLine: (line, atMs) => {
        nativeLines.push(scrub(line));
        for (const event of parser.push(line)) events.push({ atMs, event });
      },
    });
    const summary = parser.finish({ code: result.code, signal: result.signal, timedOut: result.timedOut, cancelled: result.cancelled, spawnError: result.spawnError });
    const sessionEvent = events.find((timed): timed is { atMs: number; event: Extract<AgentEvent, { t: 'session.started' }> } => timed.event.t === 'session.started');
    const reported = summary.observedModel ?? sessionEvent?.event.model.id ?? null;
    return {
      termination: summary.termination,
      terminationDetail: summary.detail,
      events,
      nativeLines,
      usage: summary.usage,
      agentMs: Date.now() - started,
      firstActionMs: firstActionMs(events),
      observedModel: reported === 'unreported' || reported === 'unknown' ? null : reported,
      observedRunnerVersion: null,
      invocation: { command: invocation.command, args: invocation.args, fake: this.options.mode === 'fake' },
      exitCode: result.code,
      logs: [
        ...invocation.notes,
        ...(result.stderr.trim() ? [`stderr tail: ${scrub(result.stderr.trim().slice(-2000))}`] : []),
        `exit ${result.code ?? result.signal}${result.timedOut ? ' (timed out)' : ''}`,
      ],
    };
  }
}
