'use strict';

/**
 * W20 operations CLI: the everyday checks and actions from a terminal —
 * find issues, see a run's state and logs, run / cancel / continue a task on
 * this machine, export a project, read insights and project knowledge.
 *
 * - The cloud API is called with a personal access token
 *   (`OPENLINEAR_TOKEN`, Settings → Personal Access Tokens) at
 *   `OPENLINEAR_API_URL` (default https://api.openlinear.tech).
 * - Runs live on this machine: run state, logs, run, cancel and continue go to
 *   the local sidecar at `OPENLINEAR_SIDECAR_URL` (default
 *   http://127.0.0.1:3003) with the same token.
 * - `--json` prints the API's own JSON for scripts. Exit codes: 0 ok, 1 the
 *   request failed, 2 usage error, 3 not signed in / token refused.
 *
 * Security:
 * - The token is only ever sent in the Authorization header and never
 *   printed. A token with spaces or control characters is refused before any
 *   request (fetch would echo it in its error). Fetch errors are reported by
 *   code only, never by message.
 * - URLs must be https://; plain http:// only for loopback (`localhost`,
 *   127.0.0.0/8, `[::1]`). URLs with a user name / password, query or
 *   fragment are refused. Redirects are refused (a 307 replays the request,
 *   body included, to another host).
 * - Known limit: the default sidecar URL is loopback http, and the token goes
 *   to whatever process listens on that port — if the app is not running,
 *   any local process could bind it. A discovery file written by the app
 *   (port + per-launch secret) is future work.
 * - Every server-provided string in human output and on stderr (and user
 *   input echoed in errors) goes through `safe()` / `safeLine()`: terminal
 *   control characters (C0 except newline and tab, DEL, C1, bidi controls)
 *   are shown as `\uXXXX`. `--json` output is JSON; DEL, C1 and bidi
 *   controls are written as `\uXXXX` escapes there too (same parsed value).
 * - Every request has a timeout and a response size cap (60 s / 32 MiB;
 *   export 300 s / 512 MiB).
 * - `export -o` writes 0600 through a temp file and a rename; an existing
 *   target is refused unless `--force`, which replaces a symlink rather than
 *   writing through it.
 */

const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const nodePath = require('node:path');
const { parseArgs } = require('node:util');

const DEFAULT_API_URL = 'https://api.openlinear.tech';
const DEFAULT_SIDECAR_URL = 'http://127.0.0.1:3003';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/;
/** Visible ASCII only: anything else in a token would end up in a header error. */
const TOKEN = /^[\x21-\x7e]+$/;
const LOOKUP_PAGE_SIZE = 100;
const LOOKUP_MAX_PAGES = 5;
const MIB = 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 60_000,
  maxBytes: 32 * MIB,
  exportTimeoutMs: 300_000,
  exportMaxBytes: 512 * MIB,
});
const CONTINUE_MESSAGE = "The previous turn was interrupted before it finished. Check the repository's current state first, then finish the task. Don't redo work that is already done.";

class UsageError extends Error {}

/** A failure reported as `CODE: message`; exit 1 unless said otherwise. */
class CommandError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** A non-2xx answer; 401 exits 3 (token refused). */
class RequestError extends CommandError {
  constructor(status, code, message) {
    super(code, message, status === 401 ? 3 : 1);
    this.status = status;
  }
}

// ─── Terminal-safe text ─────────────────────────────────────────────────────

/**
 * Characters that can drive a terminal or reorder what is shown: C0 controls
 * (newline and tab only when `keepLines` is false), DEL, C1 controls and the
 * bidi controls (U+061C, U+200E/F, U+202A–202E, U+2066–2069).
 */
function isControl(code, keepLines) {
  if (code === 0x0a || code === 0x09) return !keepLines;
  return code < 0x20
    || (code >= 0x7f && code <= 0x9f)
    || code === 0x061c
    || code === 0x200e
    || code === 0x200f
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2066 && code <= 0x2069);
}

const unicodeEscape = (code) => `\\u${code.toString(16).padStart(4, '0')}`;

function escapeControls(value, keepLines) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  // Only characters outside printable ASCII are looked at.
  return text.replace(/[^ -~]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return isControl(code, keepLines) ? unicodeEscape(code) : ch;
  });
}

/** Server text for a terminal: newlines and tabs kept, other controls shown as `\uXXXX`. */
function safe(value) {
  return escapeControls(value, true);
}

/** One-line fields (titles, identifiers, statuses, codes): newlines, CR and tabs escaped too. */
function safeLine(value) {
  return escapeControls(value, false);
}

/**
 * JSON for a terminal or a file. JSON.stringify already escapes C0; DEL, C1
 * and bidi controls (which can only occur inside strings) become `\uXXXX`
 * escapes too, so the text parses to the same value.
 */
function jsonText(body) {
  return JSON.stringify(body ?? null, null, 2).replace(/[^ -~\n]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return isControl(code, true) ? unicodeEscape(code) : ch;
  });
}

// ─── Usage ──────────────────────────────────────────────────────────────────

const USAGE = `Usage: openlinear <command> [options]

Issues
  issues --project <id> [--status todo|in_progress|done|cancelled] [--limit n]
  issue <id|ENG-12>                 One issue with its blockers and plan

Runs on this machine (local sidecar)
  status <id|ENG-12>                The latest run: state, outcome, time per phase
  logs <id|ENG-12>                  The run log
  run <id|ENG-12> [--allow-blocked] Start the agent
  cancel <id|ENG-12>                Stop the running agent
  continue <id|ENG-12> [-m text]    Continue the last run (follow-up)

Projects
  export <projectId> [-o file] [--force]
                                    Project export (JSON); --force replaces an existing file
  insights <projectId> [--range 7d|30d|90d]
  knowledge <projectId>             What every run in the project is given
  remember <projectId> --title t --body b [--kind convention|procedure|note]
                                    Propose knowledge (a person approves it)

  whoami                            The signed-in account
  install                           Install the desktop app (Linux x64)

Options: --json (machine-readable output), -h/--help
Environment: OPENLINEAR_TOKEN (personal access token), OPENLINEAR_API_URL, OPENLINEAR_SIDECAR_URL`;

/** Per command: how many positionals and which options apply (`--json` and `--help` always do). */
const COMMAND_SPECS = {
  whoami: { positionals: 0, options: [] },
  issues: { positionals: 0, options: ['project', 'status', 'limit'] },
  issue: { positionals: 1, options: [] },
  status: { positionals: 1, options: [] },
  logs: { positionals: 1, options: [] },
  run: { positionals: 1, options: ['allow-blocked'] },
  cancel: { positionals: 1, options: [] },
  continue: { positionals: 1, options: ['message'] },
  export: { positionals: 1, options: ['output', 'force'] },
  insights: { positionals: 1, options: ['range'] },
  knowledge: { positionals: 1, options: [] },
  remember: { positionals: 1, options: ['title', 'body', 'kind'] },
};
const GLOBAL_OPTIONS = ['json', 'help'];

const COMMANDS = new Set(['help', ...Object.keys(COMMAND_SPECS)]);

/** True when the launcher should hand argv to `main` (also `--json <command>`). */
function isOpsCommand(name, next) {
  if (name === '--json') return next !== '--json' && isOpsCommand(next);
  return name === '--help' || name === '-h' || COMMANDS.has(name);
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * A base URL from the environment: https (http only for loopback), no user
 * name / password, query or fragment. Errors never echo the value (it could
 * hold a password).
 */
function baseUrl(name, value, fallback) {
  const raw = (value || fallback).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`${name} is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError(`${name} must be an https:// URL.`);
  if (url.username || url.password) throw new UsageError(`${name} must not contain a user name or password.`);
  if (/[?#]/.test(raw)) throw new UsageError(`${name} must not have a query or fragment.`);
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new UsageError(`${name} must use https:// (plain http is allowed only for localhost, 127.0.0.0/8 and [::1]).`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Why a fetch failed, without its message (which can contain the request headers). */
function failureReason(error) {
  const code = error?.cause?.code;
  if (typeof code === 'string' && code) return code;
  if (error?.cause?.message === 'unexpected redirect') return 'redirect refused';
  return typeof error?.name === 'string' && error.name ? error.name : 'Error';
}

function seconds(ms) {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

function bytes(count) {
  return count % MIB === 0 ? `${count / MIB} MiB` : `${count} bytes`;
}

/** The body as text, read incrementally and abandoned past `maxBytes`. */
async function readText(response, maxBytes, tooLarge) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  try {
    return Buffer.concat(chunks, size).toString('utf8');
  } catch {
    throw tooLarge(); // longer than the longest string the runtime can hold
  }
}

function makeClient(runtime) {
  const token = (runtime.env.OPENLINEAR_TOKEN || '').trim();
  const apiUrl = baseUrl('OPENLINEAR_API_URL', runtime.env.OPENLINEAR_API_URL, DEFAULT_API_URL);
  const sidecarUrl = baseUrl('OPENLINEAR_SIDECAR_URL', runtime.env.OPENLINEAR_SIDECAR_URL, DEFAULT_SIDECAR_URL);

  /** One request; resolves with `{ status, body }` for a 2xx JSON answer (204: body null), throws otherwise. */
  async function request(target, method, path, options = {}) {
    if (!token) throw new CommandError('NO_TOKEN', 'Set OPENLINEAR_TOKEN to a personal access token (OpenLinear → Settings → Personal Access Tokens).', 3);
    if (!TOKEN.test(token)) throw new CommandError('INVALID_TOKEN', 'OPENLINEAR_TOKEN contains spaces or control characters; copy the token again.', 3);
    const base = target === 'sidecar' ? sidecarUrl : apiUrl;
    const where = target === 'sidecar' ? `the local sidecar at ${sidecarUrl} (is the OpenLinear app running?)` : `the OpenLinear API at ${apiUrl}`;
    const route = `${method} ${path.split('?')[0]}`;
    const timeoutMs = options.timeoutMs ?? runtime.limits.timeoutMs;
    const maxBytes = options.maxBytes ?? runtime.limits.maxBytes;
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    const signal = AbortSignal.timeout(timeoutMs);
    const timedOut = () => new CommandError('TIMEOUT', `No answer to ${route} from ${where} within ${seconds(timeoutMs)}.`);
    const tooLarge = () => new CommandError('RESPONSE_TOO_LARGE', `The answer to ${route} is larger than ${bytes(maxBytes)}.`);

    let response;
    try {
      response = await runtime.fetch(`${base}${path}`, {
        method,
        headers,
        redirect: 'error',
        signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      if (signal.aborted) throw timedOut();
      throw new CommandError('UNREACHABLE', `Could not reach ${where} (${failureReason(error)}).`);
    }
    let text;
    try {
      text = await readText(response, maxBytes, tooLarge);
    } catch (error) {
      if (error instanceof CommandError) throw error;
      if (signal.aborted) throw timedOut();
      throw new CommandError('UNREACHABLE', `The answer to ${route} from ${where} was cut off (${failureReason(error)}).`);
    }

    let body = null;
    let parsed = false;
    if (text) {
      try {
        body = JSON.parse(text);
        parsed = true;
      } catch {
        // not JSON
      }
    }
    if (!response.ok) {
      const code = typeof body?.code === 'string' ? body.code : `HTTP_${response.status}`;
      const message = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : `${route} failed with ${response.status}`;
      throw new RequestError(response.status, code, message);
    }
    if (response.status === 204) return { status: 204, body: null };
    if (!parsed) throw new CommandError('BAD_RESPONSE', `${route} answered ${response.status} with ${text ? 'a body that is not JSON' : 'an empty body'}.`);
    return { status: response.status, body };
  }

  return {
    request,
    call: async (target, method, path, options) => (await request(target, method, path, options)).body,
    token,
  };
}

// ─── Arguments ──────────────────────────────────────────────────────────────

function arg(positionals, index, what) {
  const value = positionals[index];
  if (!value) throw new UsageError(`Missing ${what}.`);
  return value;
}

/** Project ids are UUIDs; anything else (`..`, `.`) could reach another route. */
function projectId(value, what = 'project id') {
  if (!UUID.test(value)) throw new UsageError(`Not a ${what} (expected a UUID): ${value}`);
  return value.toLowerCase();
}

function projectArg(positionals) {
  return projectId(arg(positionals, 0, 'the project id'));
}

/** A task id from a UUID or an identifier such as ENG-12 (exact, case-insensitive match). */
async function resolveTask(client, value) {
  if (UUID.test(value)) return value;
  if (!IDENTIFIER.test(value)) throw new UsageError(`Not a task id or identifier: ${value}`);
  const wanted = value.toLowerCase();
  const matches = new Map();
  let cursor = null;
  let exhausted = false;
  // `identifier` narrows the search to exact matches; an older API ignores
  // it, so the exact filter below stays and every page of `q` is checked.
  for (let page = 0; page < LOOKUP_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ q: value, identifier: value, view: 'compact', pagination: 'cursor', pageSize: String(LOOKUP_PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    const body = await client.call('api', 'GET', `/api/tasks?${query}`);
    for (const task of Array.isArray(body?.items) ? body.items : []) {
      if (typeof task?.identifier === 'string' && task.identifier.toLowerCase() === wanted) matches.set(String(task.id), task);
    }
    cursor = typeof body?.nextCursor === 'string' && body.nextCursor ? body.nextCursor : null;
    if (!cursor) {
      exhausted = body?.hasMore !== true; // more rows but no cursor: cannot be checked
      break;
    }
  }
  if (matches.size > 1) throw new CommandError('AMBIGUOUS_IDENTIFIER', `${value} matches ${matches.size} issues in different workspaces; pass the task id.`);
  if (!exhausted) throw new CommandError('IDENTIFIER_LOOKUP_INCOMPLETE', `Too many issues match ${value} to check them all; pass the task id.`);
  if (matches.size === 0) throw new CommandError('TASK_NOT_FOUND', `No visible issue is ${value}.`);
  const [id] = matches.keys();
  if (!UUID.test(id)) throw new CommandError('BAD_RESPONSE', `The API returned an id for ${value} that is not a UUID.`);
  return id;
}

// ─── Export file ────────────────────────────────────────────────────────────

function targetExists(target) {
  return fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined;
}

function alreadyExists(target) {
  return new UsageError(`${target} already exists; pass --force to replace it.`);
}

function writeFailed(target, error) {
  return new CommandError('WRITE_FAILED', `Could not write ${target} (${error?.code ?? error?.name ?? 'Error'}).`);
}

/** Puts `temp` at `target` unless something is there: link() refuses atomically. */
function placeWithoutReplacing(temp, target) {
  try {
    fs.linkSync(temp, target);
  } catch (error) {
    if (error.code === 'EEXIST') throw alreadyExists(target);
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)) throw error;
    // No hard links on this filesystem: check, then rename.
    if (targetExists(target)) throw alreadyExists(target);
    fs.renameSync(temp, target);
  }
}

/**
 * Writes `text` to `target` with mode 0600: a new temp file in the same
 * directory (O_EXCL, 0600), then moved into place. An existing target (file,
 * directory or symlink) is refused unless `force`; with `force` the rename
 * replaces a symlink itself instead of writing through it. The temp file is
 * removed on failure.
 */
function writePrivateFile(target, text, options = {}) {
  const force = options.force === true;
  const temp = nodePath.join(nodePath.dirname(nodePath.resolve(target)), `.${nodePath.basename(target)}.${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  let renamed = false;
  try {
    if (!force && targetExists(target)) throw alreadyExists(target);
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.fchmodSync(fd, 0o600); // exact, whatever the umask
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (force) {
      fs.renameSync(temp, target);
      renamed = true;
    } else {
      placeWithoutReplacing(temp, target);
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw writeFailed(target, error);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already failing
      }
    }
    if (!renamed) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // best effort; the original error matters more
      }
    }
  }
}

// ─── Commands ───────────────────────────────────────────────────────────────

function duration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function pad(text, width) {
  const value = String(text ?? '');
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
}

/** Deterministic, so a retry after a timeout replays instead of proposing twice. */
function rememberKey(project, kind, title, body) {
  const digest = createHash('sha256').update(JSON.stringify(['remember', project, kind, title, body])).digest('hex');
  return `cli-${digest}`;
}

const handlers = {
  async whoami(client, _positionals, _values, out) {
    const me = await client.call('api', 'GET', '/api/users/me');
    return out(me, () => `${safeLine(me?.username ?? me?.email ?? me?.id)}${me?.email ? ` <${safeLine(me.email)}>` : ''}`);
  },

  async issues(client, _positionals, values, out) {
    if (values.project === undefined) throw new UsageError('Pass --project <projectId>.');
    const project = projectId(values.project, '--project id');
    const limitText = values.limit ?? '50';
    const limit = /^\d{1,3}$/.test(limitText) ? Number(limitText) : Number.NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new UsageError('--limit must be 1-200.');
    const query = new URLSearchParams({ projectId: project, pageSize: String(limit) });
    if (values.status) query.set('status', values.status);
    const page = await client.call('api', 'GET', `/api/tasks?${query}`);
    const items = Array.isArray(page?.items) ? page.items.filter((task) => task && typeof task === 'object') : [];
    return out(page, () => (items.length === 0
      ? 'No issues.'
      : items.map((task) => `${pad(safeLine(task.identifier ?? String(task.id ?? '').slice(0, 8)), 10)} ${pad(safeLine(task.status), 12)} ${safeLine(task.title)}`).join('\n')));
  },

  async issue(client, positionals, _values, out) {
    const id = await resolveTask(client, arg(positionals, 0, 'the issue (id or identifier)'));
    const task = await client.call('api', 'GET', `/api/tasks/${encodeURIComponent(id)}`);
    return out(task, () => {
      const lines = [`${safeLine(task?.identifier ?? task?.id)}  ${safeLine(task?.title)}`, `Status ${safeLine(task?.status)} · priority ${safeLine(task?.priority ?? 'none')}`];
      const blockers = Array.isArray(task?.blockedBy) ? task.blockedBy.filter((blocker) => blocker && typeof blocker === 'object') : [];
      if (blockers.length > 0) lines.push(`Blocked by: ${blockers.map((blocker) => `${safeLine(blocker.identifier ?? blocker.id)} (${safeLine(blocker.status)})`).join(', ')}`);
      if (task?.plan?.title) lines.push(`Plan: ${safeLine(task.plan.title)}`);
      if (task?.description) lines.push('', safe(String(task.description).slice(0, 2000)));
      return lines.join('\n');
    });
  },

  async status(client, positionals, _values, out) {
    const id = await resolveTask(client, arg(positionals, 0, 'the issue (id or identifier)'));
    const body = await client.call('sidecar', 'GET', `/api/tasks/${encodeURIComponent(id)}/run`);
    const run = body?.run;
    return out(body, () => {
      if (!run || typeof run !== 'object') return 'No run for this issue yet.';
      const lines = [`Run ${safeLine(run.runId)} · ${safeLine(run.state)}${run.runner ? ` · ${safeLine(run.runner)}` : ''}`];
      if (run.terminal?.outcome) lines.push(`Outcome: ${safeLine(run.terminal.outcome)}`);
      if (run.verification?.status) lines.push(`Verification: ${safeLine(run.verification.status)}`);
      const phases = run.phases;
      if (phases && typeof phases.totalMs === 'number') {
        const parts = [['Preparing', phases.preparingMs], ['Agent', phases.agentMs], ['Verifying', phases.verifyingMs], ['Publishing', phases.finishingMs]]
          .filter(([, ms]) => typeof ms === 'number' && ms >= 1000)
          .map(([label, ms]) => `${label} ${duration(ms)}`);
        lines.push(`Time: ${duration(phases.totalMs)}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}${phases.live ? ', still running' : ''}`);
      }
      return lines.join('\n');
    });
  },

  async logs(client, positionals, _values, out) {
    const id = await resolveTask(client, arg(positionals, 0, 'the issue (id or identifier)'));
    const body = await client.call('sidecar', 'GET', `/api/tasks/${encodeURIComponent(id)}/logs`);
    const logs = Array.isArray(body?.logs) ? body.logs.filter((entry) => entry && typeof entry === 'object') : [];
    return out(body, () => (logs.length === 0
      ? 'No logs.'
      : logs.map((entry) => `${safeLine(String(entry.timestamp ?? '').slice(11, 19))} ${pad(safeLine(entry.type), 7)} ${safe(entry.message)}`).join('\n')));
  },

  async run(client, positionals, values, out) {
    const id = await resolveTask(client, arg(positionals, 0, 'the issue (id or identifier)'));
    const body = await client.call('sidecar', 'POST', `/api/tasks/${encodeURIComponent(id)}/execute`, { body: values['allow-blocked'] ? { allowBlocked: true } : {} });
    return out(body, () => `Started${body?.runId ? ` run ${safeLine(body.runId)}` : ''}${body?.state ? ` (${safeLine(body.state)})` : ''}. Follow it with: openlinear status ${safeLine(positionals[0])}`);
  },

  async cancel(client, positionals, _values, out) {
    const id = await resolveTask(client, arg(positionals, 0, 'the issue (id or identifier)'));
    // 200 { message: 'Task cancelled' } (old builds { success: true }); 202 while the run is still stopping.
    const { status, body } = await client.request('sidecar', 'POST', `/api/tasks/${encodeURIComponent(id)}/cancel`, { body: {} });
    return out(body, () => {
      if (status === 202) return 'Cancelling… (still in progress)';
      if (body?.success === false) return `Not cancelled: ${safeLine(body.error ?? 'unknown reason')}`;
      if (status === 200) return 'Cancelled.';
      return `Cancel requested (HTTP ${status}).`;
    });
  },

  async continue(client, positionals, values, out) {
    const id = await resolveTask(client, arg(positionals, 0, 'the issue (id or identifier)'));
    const message = (values.message || CONTINUE_MESSAGE).trim();
    const body = await client.call('sidecar', 'POST', `/api/tasks/${encodeURIComponent(id)}/follow-up`, { body: { message, comments: [] } });
    return out(body, () => `Continuing${body?.runId ? ` in run ${safeLine(body.runId)}` : ''}${body?.state ? ` (${safeLine(body.state)})` : ''}.`);
  },

  async export(client, positionals, values, _out, runtime) {
    const project = projectArg(positionals);
    const force = values.force === true;
    // Refuse before a download of up to 512 MiB; the writer checks again.
    if (values.output && !force) {
      let exists;
      try {
        exists = runtime.exists(values.output);
      } catch (error) {
        throw writeFailed(values.output, error);
      }
      if (exists) throw alreadyExists(values.output);
    }
    const body = await client.call('api', 'GET', `/api/projects/${project}/export`, {
      timeoutMs: runtime.limits.exportTimeoutMs,
      maxBytes: runtime.limits.exportMaxBytes,
    });
    const text = `${jsonText(body)}\n`;
    if (values.output) {
      runtime.writeFile(values.output, text, { force });
      runtime.stdout.write(`Wrote ${safeLine(values.output)}\n`);
      return 0;
    }
    runtime.stdout.write(text);
    return 0;
  },

  async insights(client, positionals, values, out) {
    const project = projectArg(positionals);
    const range = values.range || '30d';
    if (!['7d', '30d', '90d'].includes(range)) throw new UsageError('--range must be 7d, 30d or 90d.');
    const body = await client.call('api', 'GET', `/api/projects/${project}/insights?range=${range}`);
    return out(body, () => {
      const runs = body?.runs ?? {};
      const delivery = body?.delivery ?? {};
      const pct = (value) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : 'n/a');
      const lines = [`Last ${range}`];
      if (typeof runs.total === 'number') {
        lines.push(`Runs ${runs.total} · success ${pct(runs.successRate)} · verified ${pct(runs.verification?.passRate)} · PR ${pct(runs.publication?.rate)}`);
        const median = runs.duration?.medianMs;
        if (typeof median === 'number') lines.push(`Run time median ${duration(median)}${typeof runs.duration.p90Ms === 'number' ? ` · p90 ${duration(runs.duration.p90Ms)}` : ''}`);
        if (runs.cost) lines.push(`Cost $${(Number(runs.cost.knownUsd) || 0).toFixed(2)}${runs.cost.unknownCostRuns ? ` + ${safeLine(runs.cost.unknownCostRuns)} run(s) with unknown cost` : ''}`);
      }
      if (typeof delivery.created === 'number') {
        lines.push(`Issues created ${delivery.created} · completed ${safeLine(delivery.completed)} · open ${safeLine(delivery.openNow)} · blocked ${safeLine(delivery.blockedNow)}`);
      }
      return lines.join('\n');
    });
  },

  async knowledge(client, positionals, _values, out) {
    const project = projectArg(positionals);
    const body = await client.call('api', 'GET', `/api/projects/${project}/knowledge`);
    const entries = (Array.isArray(body?.entries) ? body.entries : []).filter((entry) => entry && typeof entry === 'object' && entry.status !== 'retracted');
    return out(body, () => (entries.length === 0
      ? 'No project knowledge yet.'
      : entries.map((entry) => `[${safeLine(entry.kind)}${entry.status === 'proposed' ? ', proposed' : ''}] ${safeLine(entry.title)}\n  ${safe(entry.body).split('\n').join('\n  ')}`).join('\n')));
  },

  async remember(client, positionals, values, out) {
    const project = projectArg(positionals);
    if (!values.title || !values.body) throw new UsageError('Pass --title and --body.');
    const kind = values.kind || 'note';
    if (!['convention', 'procedure', 'note'].includes(kind)) throw new UsageError('--kind must be convention, procedure or note.');
    const body = await client.call('api', 'POST', `/api/projects/${project}/knowledge`, {
      body: { kind, title: values.title, body: values.body },
      idempotencyKey: rememberKey(project, kind, values.title, values.body),
    });
    return out(body, () => (body?.status === 'active'
      ? `Saved "${safeLine(body.title)}"; every run in the project gets it.`
      : `Proposed "${safeLine(body?.title)}"; a person approves it in OpenLinear (project → Knowledge).`));
  },
};

const OPTIONS = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  project: { type: 'string' },
  status: { type: 'string' },
  limit: { type: 'string' },
  range: { type: 'string' },
  output: { type: 'string', short: 'o' },
  force: { type: 'boolean' },
  message: { type: 'string', short: 'm' },
  title: { type: 'string' },
  body: { type: 'string' },
  kind: { type: 'string' },
  'allow-blocked': { type: 'boolean' },
};

/** Refuses options that don't apply to `command`, empty option values and extra positionals. */
function checkArguments(command, values, positionals) {
  const spec = COMMAND_SPECS[command];
  const allowed = new Set([...GLOBAL_OPTIONS, ...spec.options]);
  for (const [name, value] of Object.entries(values)) {
    if (!allowed.has(name)) throw new UsageError(`--${name} does not apply to "${command}".`);
    if (typeof value === 'string' && value.trim() === '') throw new UsageError(`--${name} needs a value.`);
  }
  if (positionals.length > spec.positionals) throw new UsageError(`Unexpected argument: ${positionals[spec.positionals]}`);
}

/** Runs one command; resolves with the exit code. */
async function main(argv, io = {}) {
  const runtime = {
    env: io.env ?? process.env,
    fetch: io.fetch ?? globalThis.fetch,
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    writeFile: io.writeFile ?? writePrivateFile,
    exists: io.exists ?? targetExists,
    limits: { ...DEFAULT_LIMITS, ...(io.limits ?? {}) },
  };
  // `openlinear --json whoami` is `openlinear whoami --json`.
  const args = argv[0] === '--json' && argv.length > 1 ? [argv[1], '--json', ...argv.slice(2)] : [...argv];
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    runtime.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const handler = Object.hasOwn(handlers, command) ? handlers[command] : undefined;
  if (!handler) {
    runtime.stderr.write(`Unknown command: ${safeLine(command)}\n\n${USAGE}\n`);
    return 2;
  }
  let token = '';
  // Defence in depth: the token never reaches stderr even if a message carried it.
  const report = (text) => runtime.stderr.write(token.length >= 8 ? text.split(token).join('[token]') : text);
  try {
    const { values, positionals } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
    if (values.help) {
      runtime.stdout.write(`${USAGE}\n`);
      return 0;
    }
    checkArguments(command, values, positionals);
    const client = makeClient(runtime);
    token = client.token;
    const out = (body, human) => {
      runtime.stdout.write(`${values.json ? jsonText(body) : safe(human())}\n`);
      return 0;
    };
    return await handler(client, positionals, values, out, runtime);
  } catch (error) {
    if (error instanceof CommandError) {
      report(`${safeLine(error.code)}: ${safeLine(error.message)}\n`);
      return error.exitCode;
    }
    if (error instanceof UsageError || (typeof error?.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS'))) {
      report(`${safeLine(error.message)}\nRun "openlinear help" for usage.\n`);
      return 2;
    }
    report(`${safeLine(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }
}

module.exports = { main, isOpsCommand, resolveTask, safe, safeLine, writePrivateFile, USAGE, CONTINUE_MESSAGE };
