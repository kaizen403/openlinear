import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import type { AgentEvent, AgentSession, StartInput, TokenUsage } from '@openlinear/execution-core';
import { OpenCodeRunner, confirmOpenCodeAbort, decodeOpenCodeEvent } from '../runners/opencode/index';
import { logger } from '../lib/logger';
import { getAttemptApprovalMode, getAttemptServerProcess, getClientForUser, getSandboxRunMetadata, releaseAttemptServer, setAttemptApprovalMode } from '../services/opencode';
import { HttpError } from '../lib/errors';
import { stopOrphanProcess } from './process-runtime';
import type { ResumeRuntimeInput, RunRuntime, StartedRuntimeSession } from './runtime';
import type { RuntimeEndpoint } from './types';

/**
 * OpenCode behind the run service. `start` is the existing `OpenCodeRunner`
 * (AgentRunner contract; W09a routing: the attempt's sandboxed server, or
 * the shared server under an explicit trusted-host grant). Recovery-only
 * operations talk to the journaled endpoint directly and never submit a
 * prompt.
 */

const PROBE_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Base URL and authorization of a directory-scoped OpenCode client. The
 * SDK keeps them in its (protected) hey-api client; read through
 * `getConfig()` with runtime checks so an SDK change fails loudly here
 * (and in the unit test) instead of journaling a wrong endpoint.
 */
export function describeOpenCodeClient(client: OpencodeClient): { baseUrl: string; authorization: string | null } | null {
  const inner: unknown = Reflect.get(client, '_client');
  if (!isRecord(inner)) return null;
  const getConfig = inner.getConfig;
  if (typeof getConfig !== 'function') return null;
  const config: unknown = Reflect.apply(getConfig, inner, []);
  if (!isRecord(config) || typeof config.baseUrl !== 'string' || !config.baseUrl) return null;
  const headers = config.headers;
  const authorization = headers instanceof Headers ? headers.get('authorization') : null;
  return { baseUrl: config.baseUrl, authorization };
}

function clientFor(endpoint: RuntimeEndpoint): OpencodeClient {
  return createOpencodeClient({
    baseUrl: endpoint.baseUrl,
    directory: endpoint.directory,
    ...(endpoint.authorization ? { headers: { authorization: endpoint.authorization } } : {}),
  });
}

function eventSessionId(event: Record<string, unknown>): string | undefined {
  const props = isRecord(event.properties) ? event.properties : isRecord(event.data) ? event.data : {};
  const owners: unknown[] = [];
  if ('sessionID' in props) owners.push(props.sessionID);
  if (isRecord(props.info) && 'sessionID' in props.info) owners.push(props.info.sessionID);
  if (isRecord(props.part) && 'sessionID' in props.part) owners.push(props.part.sessionID);
  const owner = owners[0];
  if (typeof owner !== 'string' || owners.some((candidate) => candidate !== owner)) return undefined;
  return owner;
}

async function inspectOpenCode(endpoint: RuntimeEndpoint, sessionId: string): Promise<'busy' | 'idle' | 'idle-error' | 'missing' | 'unreachable'> {
  const client = clientFor(endpoint);
  try {
    const status = await client.session.status({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (status.error || !status.data) return 'unreachable';
    const entry = status.data[sessionId];
    if (entry && entry.type !== 'idle') return 'busy';
    const found = await client.session.get({ path: { id: sessionId }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!found.data) return found.response?.status === 404 ? 'missing' : 'unreachable';
    const messages = await client.session.messages({ path: { id: sessionId }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!messages.data) return 'unreachable';
    const assistant = [...messages.data].reverse().find((message) => message.info.role === 'assistant');
    if (!assistant) return 'idle-error';
    return assistant.info.role === 'assistant' && assistant.info.error ? 'idle-error' : 'idle';
  } catch {
    return 'unreachable';
  }
}

/** A session attached after a restart: event stream only, no prompt. */
class AttachedOpenCodeSession implements AgentSession {
  constructor(
    readonly externalId: string,
    private readonly endpoint: RuntimeEndpoint,
    private readonly signal: AbortSignal,
  ) {}

  get events(): AsyncIterable<AgentEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const client = clientFor(self.endpoint);
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        self.signal.addEventListener('abort', onAbort, { once: true });
        try {
          const subscribed = await client.event.subscribe({ signal: controller.signal, sseMaxRetryAttempts: 1 });
          const usage: { tokens: TokenUsage; partTypes?: Map<string, 'text' | 'reasoning'> } = {
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          };
          let checked = false;
          for await (const raw of subscribed.stream) {
            if (self.signal.aborted) {
              yield { t: 'turn.finished', turn: 0, reason: 'interrupted' };
              return;
            }
            if (!checked) {
              // The turn may have ended between the probe and this
              // subscription; the idle event would then never arrive.
              checked = true;
              const now = await inspectOpenCode(self.endpoint, self.externalId);
              if (now === 'idle') {
                yield { t: 'turn.finished', turn: 0, reason: 'idle' };
                return;
              }
              if (now === 'idle-error') {
                yield { t: 'error', code: 'session', message: 'The agent ended with an error while the sidecar was down', retryable: false };
                return;
              }
            }
            const value: unknown = raw;
            if (!isRecord(value)) continue;
            const event = isRecord(value.payload) ? value.payload : value;
            if (typeof event.type !== 'string') continue;
            const connection = event.type === 'server.connected' || event.type === 'server.heartbeat';
            if (!connection && eventSessionId(event) !== self.externalId) continue;
            const decoded = decodeOpenCodeEvent({
              type: event.type,
              properties: isRecord(event.properties) ? event.properties : undefined,
              data: isRecord(event.data) ? event.data : undefined,
            }, usage);
            if (!decoded) continue;
            for (const item of Array.isArray(decoded) ? decoded : [decoded]) {
              yield item;
              if (item.t === 'turn.finished' || item.t === 'error') return;
            }
          }
        } finally {
          self.signal.removeEventListener('abort', onAbort);
          controller.abort();
        }
      },
    };
  }

  async interrupt(): Promise<void> {
    await this.abort();
  }

  async abort(): Promise<void> {
    if (!(await confirmOpenCodeAbort(clientFor(this.endpoint), this.externalId, PROBE_TIMEOUT_MS))) {
      throw new Error('Provider did not confirm abort');
    }
  }

  async replyPermission(id: string, decision: 'allow' | 'deny', scope?: 'once' | 'session'): Promise<void> {
    const response = decision === 'deny' ? 'reject' : scope === 'session' ? 'always' : 'once';
    await clientFor(this.endpoint).postSessionIdPermissionsPermissionId({
      path: { id: this.externalId, permissionID: id },
      body: { response },
    });
  }
}

export interface OpenCodeRuntimeDeps {
  runner?: OpenCodeRunner;
  clientFor?: (directory: string) => Promise<OpencodeClient>;
  sandboxMode?: (directory: string) => RuntimeEndpoint['sandboxMode'];
  /** W12a: the attempt server's process identity (default: the sandbox manager). */
  attemptProcess?: (directory: string) => { pid: number | null; launchedAt: number; spawnedBy: number } | null;
  /** W12a: stop a server process left by a previous sidecar (default: process-group stop with identity check). */
  stopOrphan?: (identity: { pid: number | null; launchedAt: number | null; spawnedBy: number }) => Promise<boolean>;
  /** FE-04: the attempt server's approval mode for the next session (default: the sandbox manager; none with an injected client). */
  setApprovalMode?: (directory: string, mode: 'policy' | 'ask') => Promise<void>;
  /** FE-04: the mode the worktree's attempt server actually runs in (null = no attempt server, e.g. trusted-host). */
  approvalModeOf?: (directory: string) => 'policy' | 'ask' | null;
}

export function createOpenCodeRuntime(deps: OpenCodeRuntimeDeps = {}): RunRuntime {
  const runner = deps.runner ?? new OpenCodeRunner();
  const resolveClient = deps.clientFor ?? ((directory: string) => getClientForUser('system', directory));
  const sandboxMode = deps.sandboxMode ?? ((directory: string) => getSandboxRunMetadata(directory)?.mode ?? 'trusted-host');
  const attemptProcess = deps.attemptProcess ?? getAttemptServerProcess;
  const stopOrphan = deps.stopOrphan ?? ((identity) => stopOrphanProcess(identity));
  const setApprovalMode = deps.setApprovalMode ?? (deps.clientFor ? async () => undefined : setAttemptApprovalMode);
  const approvalModeOf = deps.approvalModeOf ?? (deps.clientFor ? () => null : getAttemptApprovalMode);
  /** An "ask" session must not run on a server that answers by policy (fail closed; nothing was prompted yet). */
  const assertAsks = (directory: string, permissions: { default: string }) => {
    if (permissions.default !== 'ask') return;
    const actual = approvalModeOf(directory);
    if (actual !== null && actual !== 'ask') {
      throw new HttpError(409, 'APPROVAL_MODE_UNAVAILABLE', "The agent server for this checkout is still busy in another approval mode; try again when its current session has ended");
    }
  };
  /** Sessions this process started, by OpenCode session id (their own abort is the checked one). */
  const live = new Map<string, { session: AgentSession; directory: string }>();

  const endpointFor = async (directory: string, resumedSessionId: string | null): Promise<RuntimeEndpoint | null> => {
    // Same routing as the runner (cached per worktree): the attempt's
    // server, or the shared server under a trusted-host grant.
    const described = describeOpenCodeClient(await resolveClient(directory));
    const mode = sandboxMode(directory);
    // W12a: the enforce-mode attempt server's identity, so a restarted
    // sidecar can stop it if the run can't be adopted (no surviving server).
    const serverProcess = mode === 'enforce' ? attemptProcess(directory) : null;
    return described
      ? {
          kind: 'opencode',
          baseUrl: described.baseUrl,
          directory,
          authorization: described.authorization,
          sandboxMode: mode,
          ...(serverProcess ? { process: serverProcess } : {}),
          ...(resumedSessionId ? { resumedSessionId } : {}),
        }
      : null;
  };

  return {
    runnerId: 'opencode',
    // FE-04: asks through its attempt server's config (sandboxed runs only;
    // the shared trusted-host server keeps its policy).
    approvals: 'interactive',

    async start(input: StartInput): Promise<StartedRuntimeSession> {
      await setApprovalMode(input.worktreePath, input.permissions.default === 'ask' ? 'ask' : 'policy');
      const session = await runner.start(input);
      try {
        assertAsks(input.worktreePath, input.permissions);
      } catch (error) {
        await session.abort().catch(() => undefined);
        throw error;
      }
      live.set(session.externalId, { session, directory: input.worktreePath });
      return { session, endpoint: await endpointFor(input.worktreePath, null) };
    },

    /**
     * W07a follow-up: continue the saved session on the worktree's server
     * (W09a keeps the attempt's private root — OpenCode's session store —
     * while the worktree exists, and restarts the server lazily). Null when
     * that server no longer knows the session.
     */
    async resume(input: ResumeRuntimeInput): Promise<StartedRuntimeSession | null> {
      await setApprovalMode(input.worktreePath, input.permissions.default === 'ask' ? 'ask' : 'policy');
      const client = await resolveClient(input.worktreePath);
      assertAsks(input.worktreePath, input.permissions);
      const found = await client.session.get({ path: { id: input.sessionId }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).catch(() => null);
      if (!found?.data) return null;
      const session = await runner.resume(input.sessionId, {
        worktreePath: input.worktreePath,
        signal: input.signal,
        prompt: input.prompt,
        permissions: input.permissions,
        env: input.env,
        ...(input.model ? { model: input.model } : {}),
      });
      live.set(session.externalId, { session, directory: input.worktreePath });
      return { session, endpoint: await endpointFor(input.worktreePath, input.sessionId) };
    },

    inspect: inspectOpenCode,

    async attach(endpoint, sessionId, signal) {
      return new AttachedOpenCodeSession(sessionId, endpoint, signal);
    },

    async release(endpoint) {
      for (const [id, entry] of live) if (entry.directory === endpoint.directory) live.delete(id);
      if (endpoint.sandboxMode !== 'enforce') return;
      // This process's own attempt server is closed by its manager; a server
      // a previous sidecar left behind is stopped through its journaled
      // identity (W12a: never a recycled pid; unknown identity → left alone).
      const owned = await releaseAttemptServer(endpoint.directory);
      if (!owned && endpoint.process) {
        const stopped = await stopOrphan(endpoint.process);
        logger.info({ directory: endpoint.directory, pid: endpoint.process.pid, stopped }, '[RunEngine] orphaned sandboxed OpenCode server from a previous sidecar');
      }
    },

    /**
     * W07a: a session this process started is stopped through the runner's
     * own `OpenCodeSession.abort()`, which resolves only on OpenCode's
     * positive receipt; a session from a previous sidecar is aborted at the
     * journaled endpoint with the same receipt check.
     */
    async abort(endpoint, sessionId) {
      const own = live.get(sessionId);
      if (own) {
        try {
          await own.session.abort();
          return true;
        } catch {
          return false;
        }
      }
      if (!endpoint) return false;
      return confirmOpenCodeAbort(clientFor(endpoint), sessionId, PROBE_TIMEOUT_MS);
    },
  };
}
