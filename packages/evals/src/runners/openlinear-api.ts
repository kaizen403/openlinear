import type { Termination } from '../grading/outcome';
import { UNKNOWN_USAGE } from '../usage/cost';
import { git, gitTry } from '../util/git';
import { terminationForErrorCode } from './classify';
import type { FeatureSupport, HarnessRunner, RunnerResult, TrialContext } from './types';

/**
 * OpenLinear in the loop, full headless path: the task goes through the real
 * control plane and sidecar exactly as a user's would —
 *
 *   POST {api}/api/tasks                       create the task in an eval project
 *   POST {sidecar}/api/tasks/:id/execute       attempt + capability + clone + runner + claim
 *   GET  {sidecar}/api/tasks/:id/running       poll until the run ends (wall-clock budget)
 *   POST {sidecar}/api/tasks/:id/cancel        on timeout
 *   GET  {sidecar}/api/tasks/:id/logs          execution log
 *   GET  {api}/api/tasks/:id                   terminal task status
 *   harvest                                    pull the published branch back into the trial worktree
 *
 * Prerequisites (operator-provided, mirroring apps/api sidecar-api-only.e2e):
 * an eval user + PAT (tasks:write), a workspace/project/team whose repository
 * `cloneUrl` is a local bare origin (`OPENLINEAR_ALLOW_FILE_GIT=1`), a loopback
 * GitHub stub for PR creation (`OPENLINEAR_GITHUB_API_URL`), and a sidecar
 * started with `OPENLINEAR_API_URL` pointing at the API. Because the origin is
 * shared, run this transport with `maxConcurrentTrials: 1` or one project per
 * task. Usage receipts are not readable through the API yet, so usage is
 * reported as unknown (never 0) — see the ledger follow-ups.
 */

export interface ApiHarvestResult {
  applied: boolean;
  detail: string;
}

export interface OpenLinearApiRunnerOptions {
  apiUrl: string;
  sidecarUrl: string;
  /** Bearer for the eval principal (PAT with tasks:write). Never recorded. */
  token: () => string;
  projectId: string;
  teamId?: string;
  /** Called before each trial: make the project's origin hold the task's base commit. */
  prepareOrigin: (context: TrialContext) => Promise<void>;
  /** Brings the run's published changes into `context.worktree` (relative to the base commit). */
  harvest: (context: TrialContext, taskId: string) => Promise<ApiHarvestResult>;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class OpenLinearApiRunner implements HarnessRunner {
  readonly kind = 'openlinear-api';
  /** The sidecar builds the prompt from the task snapshot: no per-trial features (W21 refuses them at plan time). */
  readonly featureSupport: FeatureSupport = { promptSections: false, reviewPhases: false };

  constructor(private readonly options: OpenLinearApiRunnerOptions) {}

  private async call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<JsonResponse> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${this.options.token()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed: unknown = {};
    try {
      parsed = await response.json();
    } catch {
      parsed = {};
    }
    const record = isRecord(parsed) ? parsed : { value: parsed };
    // Unwrap `{ data: … }` envelopes.
    const inner = isRecord(record.data) ? record.data : record;
    return { status: response.status, body: inner };
  }

  /** The HTTP plan for a trial, for dry runs and audit (no credentials). */
  plan(context: Pick<TrialContext, 'trialId'>): string[] {
    const { apiUrl, sidecarUrl, projectId } = this.options;
    return [
      `POST ${apiUrl}/api/tasks {title: "[eval ${context.trialId}] …", projectId: ${projectId}}`,
      `POST ${sidecarUrl}/api/tasks/:id/execute`,
      `GET  ${sidecarUrl}/api/tasks/:id/running   (every ${this.options.pollIntervalMs ?? 2000} ms until false or the wall-clock budget)`,
      `POST ${sidecarUrl}/api/tasks/:id/cancel    (only on timeout)`,
      `GET  ${sidecarUrl}/api/tasks/:id/logs`,
      `GET  ${apiUrl}/api/tasks/:id`,
      'harvest: fetch the published branch from the bare origin into the trial worktree',
    ];
  }

  async run(ctx: TrialContext): Promise<RunnerResult> {
    const { apiUrl, sidecarUrl } = this.options;
    const logs: string[] = [];
    const started = Date.now();
    const finish = (termination: Termination, terminationDetail: string): RunnerResult => ({
      termination,
      terminationDetail,
      events: [],
      nativeLines: [],
      usage: UNKNOWN_USAGE,
      agentMs: Date.now() - started,
      firstActionMs: null,
      observedModel: null,
      observedRunnerVersion: null,
      invocation: { command: 'http', args: this.plan(ctx), fake: false },
      logs,
    });

    try {
      await this.options.prepareOrigin(ctx);
      const created = await this.call('POST', `${apiUrl}/api/tasks`, {
        title: `[eval ${ctx.trialId}] ${ctx.task.spec.title}`,
        description: ctx.prompt,
        projectId: this.options.projectId,
        ...(this.options.teamId ? { teamId: this.options.teamId } : {}),
        model: `${ctx.configuration.model.provider}/${ctx.configuration.model.snapshot || ctx.configuration.model.requested}`,
      });
      const taskId = typeof created.body.id === 'string' ? created.body.id : null;
      if (created.status >= 300 || !taskId) return finish('infra', `task create failed (${created.status})`);
      logs.push(`task ${taskId} created`);

      const executed = await this.call('POST', `${sidecarUrl}/api/tasks/${taskId}/execute`);
      if (executed.status >= 300) {
        const code = typeof executed.body.code === 'string' ? executed.body.code : `HTTP_${executed.status}`;
        logs.push(`execute refused: ${code} ${String(executed.body.error ?? '')}`);
        const termination = terminationForErrorCode(code);
        return finish(termination === 'agent-error' ? 'infra' : termination, `execute refused (${code})`);
      }

      const deadline = started + ctx.manifest.budgets.agentTimeoutMs;
      let timedOut = false;
      for (;;) {
        if (ctx.signal.aborted) break;
        const running = await this.call('GET', `${sidecarUrl}/api/tasks/${taskId}/running`);
        if (running.status < 300 && running.body.running === false) break;
        if (Date.now() >= deadline) {
          timedOut = true;
          logs.push('wall-clock budget elapsed: cancel');
          await this.call('POST', `${sidecarUrl}/api/tasks/${taskId}/cancel`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? 2000));
      }

      const executionLogs = await this.call('GET', `${sidecarUrl}/api/tasks/${taskId}/logs`);
      const entries = Array.isArray(executionLogs.body.logs) ? executionLogs.body.logs : [];
      for (const entry of entries.slice(-500)) logs.push(`log ${JSON.stringify(entry).slice(0, 2000)}`);

      const task = await this.call('GET', `${apiUrl}/api/tasks/${taskId}`);
      const status = typeof task.body.status === 'string' ? task.body.status : 'unknown';
      logs.push(`task status ${status}`);

      const harvest = await this.options.harvest(ctx, taskId);
      logs.push(`harvest: ${harvest.detail}`);

      if (timedOut) return finish('timeout', 'wall-clock budget');
      if (ctx.signal.aborted) return finish('cancelled', 'harness cancelled the trial');
      if (status === 'done') return finish('completed', 'done (publication confirmed)');
      if (status === 'in_progress') return finish('infra', 'run ended but the task is still in progress');
      return finish('agent-error', `task ended ${status}`);
    } catch (error) {
      logs.push(`transport error: ${error instanceof Error ? error.message : String(error)}`);
      return finish('infra', 'transport error');
    }
  }
}

/**
 * Harvester for the loopback-origin setup: fetches the newest non-`main`
 * branch the sidecar pushed and makes the trial worktree's files match it
 * (HEAD stays at the base commit, so the common patch capture sees the diff).
 */
export function bareOriginHarvester(originPath: string): OpenLinearApiRunnerOptions['harvest'] {
  return async (ctx) => {
    const refs = (await git(originPath, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads/'])).split('\n').filter(Boolean);
    const branch = refs.find((ref) => ref !== 'refs/heads/main');
    if (!branch) return { applied: false, detail: 'no published branch in the origin' };
    const fetched = await gitTry(ctx.worktree, ['fetch', '--quiet', '--no-tags', originPath, branch]);
    if (fetched.code !== 0) return { applied: false, detail: `fetch failed: ${fetched.stderr.trim().slice(-300)}` };
    await git(ctx.worktree, ['read-tree', '-u', '--reset', 'FETCH_HEAD']);
    return { applied: true, detail: `applied ${branch}` };
  };
}

/** Resets the bare origin's `main` to the trial's base commit and removes other branches. */
export function bareOriginPreparer(originPath: string): OpenLinearApiRunnerOptions['prepareOrigin'] {
  return async (ctx) => {
    await git(ctx.worktree, ['push', '--quiet', '--force', originPath, `${ctx.baseSha}:refs/heads/main`]);
    const refs = (await git(originPath, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).split('\n').filter(Boolean);
    for (const ref of refs) if (ref !== 'refs/heads/main') await git(originPath, ['update-ref', '-d', ref]);
  };
}
