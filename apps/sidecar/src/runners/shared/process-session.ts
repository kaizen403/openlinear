import type { AgentEvent, AgentSession } from '@openlinear/execution-core';
import { AsyncQueue } from './async-queue';
import { JsonLineSplitter, type JsonLine } from './jsonl';
import { terminateProcessGroup, waitForExit, type ExitInfo } from './process-group';
import type { RunnerProcess } from './sandboxed-process';

export type CancelVia = 'interrupt' | 'abort' | 'signal';

/** Default grace between SIGTERM and SIGKILL for a runner's process group. */
export const DEFAULT_KILL_GRACE_MS = 5_000;
/** How long a runner may take to exit on its own after its terminal event. */
export const DEFAULT_EXIT_AFTER_TERMINAL_MS = 10_000;
/** Most diagnostics emitted for malformed lines in one session (then counted only). */
const MAX_LINE_DIAGNOSTICS = 20;
const STDERR_TAIL_BYTES = 4096;
const STDOUT_DRAIN_MS = 2_000;

const SECRET_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

/** Removes credential-shaped substrings from runner output before it is surfaced. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, '[redacted]');
  return out;
}

export interface ProcessSessionOptions {
  signal: AbortSignal;
  killGraceMs?: number;
  exitAfterTerminalMs?: number;
}

/**
 * Shared lifecycle for adapters that drive a runtime CLI over stdio JSONL.
 *
 * Guarantees (the W07 conformance contract):
 * - exactly one terminal `turn.finished`, after which nothing is emitted;
 * - stdout EOF / process exit without a provider terminal is a failure,
 *   never success;
 * - a cancellation ends with `cancel.receipt` + `turn.finished interrupted`
 *   only once it is confirmed (runtime ack or observed exit);
 * - malformed lines are tolerated and reported as `diagnostic` events;
 * - the whole process group is reaped after the terminal event.
 */
export abstract class ProcessAgentSession implements AgentSession {
  protected readonly queue = new AsyncQueue<AgentEvent>();
  protected proc: RunnerProcess | null = null;
  protected turn = 0;
  protected cancelVia: CancelVia | null = null;
  private terminalReached = false;
  private consumed = false;
  private stderrTail = '';
  private lineDiagnostics = 0;
  private suppressedLines = 0;
  private resolveTerminal!: () => void;
  private readonly terminalPromise: Promise<void>;
  private terminationStarted = false;
  private reaped: Promise<void> | null = null;
  private cancelling: Promise<void> | null = null;
  /** W07a: input written when the event stream is first consumed (the prompt). */
  private pendingInput: (() => void) | null = null;
  private stopOutcome: 'stopped' | 'unconfirmed' | null = null;
  protected readonly killGraceMs: number;
  private readonly exitAfterTerminalMs: number;
  private readonly signal: AbortSignal;

  abstract get externalId(): string;

  protected constructor(options: ProcessSessionOptions) {
    this.signal = options.signal;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.exitAfterTerminalMs = options.exitAfterTerminalMs ?? DEFAULT_EXIT_AFTER_TERMINAL_MS;
    this.terminalPromise = new Promise((resolve) => {
      this.resolveTerminal = resolve;
    });
  }

  get finished(): boolean {
    return this.terminalReached;
  }

  /**
   * W07a: whether the runtime is known to be stopped. `null` while the turn
   * runs; `true` once it ended (a provider terminal, a confirmed
   * cancellation receipt, or an observed exit); `false` when a stop was
   * attempted and could not be confirmed (`cancel_unconfirmed`).
   */
  get stopConfirmed(): boolean | null {
    if (!this.terminalReached) return null;
    return this.stopOutcome !== 'unconfirmed';
  }

  /**
   * W07a: identity of the runtime process for durable recovery — the
   * process-group leader pid (runner processes are spawned detached) and
   * when the launch began. Null before anything was spawned.
   */
  get processInfo(): { pid: number | null; launchedAt: number | null; mode: 'enforce' | 'trusted-host' } | null {
    const proc = this.proc;
    if (!proc) return null;
    const launchedAt = Date.parse(proc.metadata.startedAt);
    return { pid: proc.pid ?? null, launchedAt: Number.isFinite(launchedAt) ? launchedAt : null, mode: proc.mode };
  }

  /**
   * W07a: defer runtime input (the prompt) until the event stream is first
   * consumed, so the process can be spawned — and sandbox, binary and
   * credential failures surface — before anything is submitted, and a run
   * engine can journal the prompt intent between the two (journal before
   * dispatch). Runs immediately if the stream is already being consumed.
   */
  protected deferUntilConsumed(write: () => void): void {
    if (this.consumed) {
      write();
      return;
    }
    this.pendingInput = write;
  }

  /** Resolves once the terminal event has been queued. */
  whenTerminal(): Promise<void> {
    return this.terminalPromise;
  }

  /**
   * Resolves once the terminal event was queued AND the runtime's process
   * group has been reaped and its sandbox resources released.
   */
  async whenClosed(): Promise<void> {
    await this.terminalPromise;
    await (this.reaped ?? Promise.resolve());
  }

  /** Called by subclasses once the process is spawned. */
  protected attach(proc: RunnerProcess): void {
    this.proc = proc;
    const splitter = new JsonLineSplitter((line) => this.handleLine(line));
    let resolveStdout!: () => void;
    const stdoutDone = new Promise<void>((resolve) => {
      resolveStdout = resolve;
    });
    proc.stdout.on('data', (chunk: Buffer) => splitter.push(chunk));
    proc.stdout.once('end', () => {
      splitter.end();
      resolveStdout();
    });
    proc.stdout.once('close', () => resolveStdout());
    proc.stdout.once('error', () => resolveStdout());
    proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    // A descendant that inherited stdout can keep the pipe open after the
    // runtime itself exited; do not wait for it beyond a short drain window.
    void proc.exited.then(async (exit) => {
      await Promise.race([stdoutDone, new Promise<void>((resolve) => setTimeout(resolve, STDOUT_DRAIN_MS).unref?.())]);
      this.handleStreamsClosed(exit);
    });
    if (this.signal.aborted) {
      void this.cancel('signal');
    } else {
      this.signal.addEventListener('abort', this.onSignal, { once: true });
    }
  }

  private readonly onSignal = (): void => {
    void this.cancel('signal');
  };

  /** For sessions whose start was cancelled before anything was spawned. */
  protected finishNotStarted(via: CancelVia): void {
    this.cancelVia = via;
    this.finish([{ t: 'cancel.receipt', via, confirmedBy: 'not-started' }], 'interrupted');
  }

  /** Last stderr bytes, secret-scrubbed, for failure messages. */
  protected stderrSummary(): string {
    const tail = scrubSecrets(this.stderrTail).trim();
    return tail ? tail.split('\n').slice(-5).join('\n') : '';
  }

  private handleLine(line: JsonLine): void {
    if (this.terminalReached) return;
    if (!line.ok) {
      this.reportLine(line.reason === 'too_long' ? 'line_too_long' : 'malformed_line', `Ignored a ${line.reason === 'too_long' ? 'too-long' : 'malformed'} line from the runner`, line.sample);
      return;
    }
    try {
      this.onMessage(line.value);
    } catch (err) {
      this.reportLine('invalid_event', `Ignored an event the adapter could not decode: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Bounded diagnostics for tolerated input problems. */
  protected reportLine(code: string, message: string, detail?: string): void {
    if (this.lineDiagnostics >= MAX_LINE_DIAGNOSTICS) {
      this.suppressedLines += 1;
      return;
    }
    this.lineDiagnostics += 1;
    this.emit({ t: 'diagnostic', code, message, ...(detail ? { detail: scrubSecrets(detail) } : {}) });
  }

  /** Decode one parsed JSON line. Throwing reports `invalid_event`. */
  protected abstract onMessage(value: unknown): void;

  /** Subclass hook: the provider stream ended without a terminal event. */
  protected abstract eofFailure(exit: ExitInfo): { code: string; message: string };

  protected emit(event: AgentEvent): void {
    if (this.terminalReached) return;
    this.queue.push(event);
  }

  /** Queues `events` and the single terminal event, then reaps the process. */
  protected finish(events: AgentEvent[], reason: 'idle' | 'max_turns' | 'error' | 'interrupted'): void {
    if (this.terminalReached) return;
    this.stopOutcome = events.some((event) => event.t === 'error' && event.code === 'cancel_unconfirmed') ? 'unconfirmed' : 'stopped';
    // A turn that ended before its input was consumed never receives it.
    this.pendingInput = null;
    for (const event of events) this.queue.push(event);
    if (this.suppressedLines > 0) {
      this.queue.push({ t: 'diagnostic', code: 'diagnostics_suppressed', message: `${this.suppressedLines} further malformed or undecodable lines were ignored` });
    }
    this.queue.push({ t: 'turn.finished', turn: this.turn, reason });
    this.terminalReached = true;
    this.queue.close();
    this.signal.removeEventListener('abort', this.onSignal);
    this.resolveTerminal();
    this.reaped = this.reap();
  }

  /** After the terminal event: let the runtime exit, then reap its whole group. */
  private async reap(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.closeStdin();
    if (!proc.isExited()) await waitForExit(proc.exited, this.exitAfterTerminalMs);
    await terminateProcessGroup(proc, this.killGraceMs);
    await proc.dispose();
  }

  protected closeStdin(): void {
    const stdin = this.proc?.stdin;
    if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.end();
  }

  protected writeLine(value: unknown): boolean {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
    stdin.write(`${JSON.stringify(value)}\n`);
    return true;
  }

  private handleStreamsClosed(exit: ExitInfo): void {
    if (this.terminalReached) return;
    if (this.cancelVia) {
      this.finish([{ t: 'cancel.receipt', via: this.cancelVia, confirmedBy: 'process-exit', exitCode: exit.code, exitSignal: exit.signal }], 'interrupted');
      return;
    }
    const spawnError = this.proc?.spawnError();
    const failure = spawnError
      ? { code: 'spawn_failed', message: `The runner could not be started: ${spawnError.message}` }
      : this.eofFailure(exit);
    const stderr = this.stderrSummary();
    this.finish([
      { t: 'diagnostic', code: 'process_exit', message: `Runner exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 'unknown'}`}`, ...(stderr ? { detail: stderr } : {}) },
      { t: 'error', code: failure.code, message: failure.message, retryable: false },
    ], 'error');
  }

  /**
   * Common cancellation: subclasses with a graceful in-band interrupt
   * override `interrupt()`; everything else stops the process group.
   */
  protected async cancel(via: CancelVia): Promise<void> {
    if (this.terminalReached) return;
    if (!this.cancelVia) this.cancelVia = via;
    // abort() may escalate at any time, even while a graceful interrupt waits.
    if (via === 'abort') {
      await this.terminate();
      return;
    }
    // Single flight: signal → interrupt() (the engine's cancelRun order) must
    // not send a second in-band interrupt.
    if (!this.cancelling) {
      this.cancelling = (async () => {
        await this.gracefulInterrupt(via);
        if (!this.terminalReached) await this.terminate();
      })();
    }
    await this.cancelling;
  }

  /** Default: no graceful path. Subclasses return once the turn has ended (or give up). */
  protected async gracefulInterrupt(_via: CancelVia): Promise<void> {
    return undefined;
  }

  /** Close stdin, SIGTERM → grace → SIGKILL the group; terminal follows the observed exit. */
  protected async terminate(): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      this.finishNotStarted(this.cancelVia ?? 'abort');
      return;
    }
    if (!this.terminationStarted) {
      this.terminationStarted = true;
      // An unsent prompt stays unsent: closing stdin first could hand the
      // runtime an empty input (EOF) to act on before the signal lands.
      const inputPending = this.pendingInput !== null;
      this.pendingInput = null;
      if (!inputPending) this.closeStdin();
      const receipt = await terminateProcessGroup(proc, this.killGraceMs);
      if (!receipt.exit && !this.terminalReached) {
        this.finish([
          { t: 'error', code: 'cancel_unconfirmed', message: 'The runner process did not exit after SIGKILL; it could not be confirmed stopped', retryable: false },
        ], 'error');
      }
    }
    await this.terminalPromise;
  }

  async interrupt(): Promise<void> {
    await this.cancel('interrupt');
  }

  async abort(): Promise<void> {
    await this.cancel('abort');
  }

  async replyPermission(_id: string, _decision: 'allow' | 'deny', _scope?: 'once' | 'session'): Promise<void> {
    throw new Error('This runner does not support interactive permission replies');
  }

  get events(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        if (this.consumed) throw new Error('Runner session events can only be consumed once');
        this.consumed = true;
        const input = this.pendingInput;
        this.pendingInput = null;
        if (input && !this.terminalReached) input();
        return {
          next: () => this.queue.next(),
          return: async () => {
            // A consumer that stops early must not leave the runtime running.
            if (!this.terminalReached) void this.abort();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}
