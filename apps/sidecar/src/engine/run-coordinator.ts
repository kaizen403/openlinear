import {
  admitRun,
  type AgentRunner,
  type AgentSession,
  FakeAgentRunner,
} from '@openlinear/execution-core';
import { RunJournal } from '../journal/sqlite';
import { SessionManager } from './session-manager';
import { cancelRun } from './cancel';
import { EXECUTION_SYSTEM_CONTRACT } from './system-contract';

export interface QueuedStart {
  runId: string;
  start: () => Promise<void>;
}

export class RunCoordinator {
  private readonly liveRuns = new Set<string>();
  private readonly liveBatches = new Set<string>();
  private readonly liveWorktrees = new Set<string>();
  private readonly queue: QueuedStart[] = [];
  private readonly sessions = new Map<string, AgentSession>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly journal: RunJournal,
    private readonly sessionManager: SessionManager,
    private readonly runners: Map<string, AgentRunner>,
    private readonly limits = { maxRuns: 4, maxBatches: 2, maxWorktrees: 8 },
  ) {}

  getRunner(id: string): AgentRunner {
    const runner = this.runners.get(id) ?? this.runners.get('opencode');
    if (!runner) throw new Error(`No agent runner registered for ${id}`);
    return runner;
  }

  async start(input: {
    runId: string;
    taskId: string;
    batchId?: string | null;
    runnerId: string;
    worktreePath: string;
    prompt: string;
    model?: { id: string; provider?: string };
    onComplete: (ok: boolean, error?: string) => Promise<void>;
  }): Promise<void> {
    const decision = admitRun({
      liveRuns: this.liveRuns.size,
      liveBatches: this.liveBatches.size,
      liveWorktrees: this.liveWorktrees.size,
      maxRuns: this.limits.maxRuns,
      maxBatches: this.limits.maxBatches,
      maxWorktrees: this.limits.maxWorktrees,
      isBatch: Boolean(input.batchId),
    });
    const begin = async () => {
      this.liveRuns.add(input.runId);
      if (input.batchId) this.liveBatches.add(input.batchId);
      this.liveWorktrees.add(input.worktreePath);
      const controller = new AbortController();
      this.controllers.set(input.runId, controller);
      this.journal.startRun({
        id: input.runId,
        taskId: input.taskId,
        batchId: input.batchId ?? null,
        runner: input.runnerId,
        externalSessionId: null,
        worktreePath: input.worktreePath,
        status: 'running',
        budgetsJson: JSON.stringify({ wallClockMs: 6 * 60 * 60 * 1000 }),
        usageJson: null,
      });
      const runner = this.getRunner(input.runnerId);
      const session = await runner.start({
        runId: input.runId,
        worktreePath: input.worktreePath,
        systemContract: EXECUTION_SYSTEM_CONTRACT,
        prompt: input.prompt,
        model: input.model,
        budgets: { wallClockMs: 6 * 60 * 60 * 1000 },
        permissions: { default: 'allow' },
        sandbox: { cwd: input.worktreePath, env: {} },
        env: {},
        signal: controller.signal,
      });
      this.sessions.set(input.runId, session);
      this.journal.setStatus(input.runId, 'running');
      await this.sessionManager.attach(input.runId, session, async (ok, error) => {
        this.journal.setStatus(input.runId, ok ? 'succeeded' : 'failed', Date.now());
        this.release(input);
        await input.onComplete(ok, error);
      });
    };

    if (!decision.admitted) {
      this.queue.push({ runId: input.runId, start: begin });
      return;
    }
    await begin();
  }

  async cancel(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    const controller = this.controllers.get(runId);
    await cancelRun({ session, signal: controller });
  }

  private release(input: { runId: string; batchId?: string | null; worktreePath: string }): void {
    this.liveRuns.delete(input.runId);
    this.liveWorktrees.delete(input.worktreePath);
    if (input.batchId) this.liveBatches.delete(input.batchId);
    this.sessions.delete(input.runId);
    this.controllers.delete(input.runId);
    const next = this.queue.shift();
    if (next) void next.start();
  }
}

export function createTestCoordinator(runner = new FakeAgentRunner()) {
  const journal = new RunJournal(':memory:');
  const sessionManager = new SessionManager(journal);
  const runners = new Map<string, AgentRunner>([['opencode', runner], ['codex', runner]]);
  return { coordinator: new RunCoordinator(journal, sessionManager, runners), journal, runner };
}
