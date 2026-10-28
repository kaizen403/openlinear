/**
 * W11a — "done means verified": the verification contract.
 *
 * A run's acceptance checks are resolved and sealed BEFORE the agent runs
 * (the verification manifest, journaled with the run), so the agent cannot
 * change what gets graded. After the agent's turn the run service commits
 * the work (the candidate commit), executes the sealed checks against that
 * exact commit in a pristine checkout inside the sandbox, records an
 * exit-code-based result per check, and applies the publication policy.
 *
 * Check-definition precedence (first source with checks wins):
 *   1. project execution settings (control plane, captured in the attempt
 *      snapshot);
 *   2. `.openlinear/checks.json` read from the run's BASE commit — never the
 *      agent's modified copy;
 *   3. conservative auto-detection from the base commit's package.json, only
 *      when the project explicitly enables it.
 * The publication policy comes only from the project settings (default
 * `warn`): a repository file decides what runs, not whether it gates.
 *
 * Pure: no I/O, no Node APIs. Hashing is injected by the caller.
 *
 * W16a: the same settings carry the project's environment setup steps
 * (`setup`, see `setup.ts`), parsed with the same check rules.
 */
import { SETUP_LIMITS, setupStepIdentity, type SetupPlan } from './setup';

export * from './setup';

// ---------------------------------------------------------------------------
// Policy and limits
// ---------------------------------------------------------------------------

export const VERIFICATION_POLICIES = ['require-pass', 'warn', 'off'] as const;
/**
 * - `require-pass`: publish only when every required check passed. A failed
 *   or unevaluable verification (or no checks at all) blocks publication;
 *   the run fails with the work retained.
 * - `warn`: verify, then publish whatever the result; the outcome and the
 *   evidence say how verification went. (Default for now.)
 * - `off`: no verification step.
 */
export type VerificationPolicy = (typeof VERIFICATION_POLICIES)[number];
export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = 'warn';

export const VERIFICATION_LIMITS = {
  maxChecks: 20,
  maxCommandChars: 4_000,
  maxArgv: 64,
  maxNameChars: 120,
  maxCwdChars: 512,
  maxHosts: 20,
  defaultTimeoutSeconds: 600,
  minTimeoutSeconds: 1,
  maxTimeoutSeconds: 3_600,
  /** Bytes of a check's combined output kept in its log artifact. */
  maxLogBytes: 1024 * 1024,
  /** Bytes of the output's end kept in the evidence record (redacted). */
  logTailBytes: 4 * 1024,
  /** Raw repository file bound (`.openlinear/checks.json`). */
  maxConfigBytes: 64 * 1024,
} as const;

/** Path of the repository check file, read from the run's base commit. */
export const REPOSITORY_CHECKS_PATH = '.openlinear/checks.json';

export function isVerificationPolicy(value: unknown): value is VerificationPolicy {
  return typeof value === 'string' && (VERIFICATION_POLICIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Check definitions
// ---------------------------------------------------------------------------

/** Network a check may use. Default `none`; egress goes through the sandbox's egress proxy allowlist. */
export type VerificationNetwork =
  | { mode: 'none' }
  | { mode: 'egress'; hosts: string[]; registries: boolean };

/** A normalized, sealed check. `argv` is never re-parsed: a `run` string became `['/bin/sh', '-c', run]`. */
export interface VerificationCheckSpec {
  id: string;
  name: string;
  argv: string[];
  /** Relative POSIX directory inside the checkout ('' = the checkout root). */
  cwd: string;
  timeoutMs: number;
  network: VerificationNetwork;
  /** A non-required check is informational: its failure does not fail verification. */
  required: boolean;
}

/** Project execution settings: `executionSettings.verification` on the project. */
export interface ProjectVerificationSettings {
  policy: VerificationPolicy;
  checks: VerificationCheckSpec[];
  /** Conservative auto-detection when neither project nor repository defines checks. */
  autoDetect: boolean;
  /** Honour `.openlinear/checks.json` from the base commit (default true). */
  repositoryChecks: boolean;
  /**
   * W16a: environment setup steps run in the run's worktree before the
   * agent starts (≤ SETUP_LIMITS.maxSteps; independent of the policy).
   */
  setup: VerificationCheckSpec[];
}

export type ParseResult<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[] };

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOST_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::[0-9]{1,5})?$/;
/**
 * A last label of digits (`127.0.0.1`, `127.1`, `10.0.0.5:5432`) is an IP
 * address, never a DNS name. Checks and setup steps come from project
 * settings and repository files, so they may only name hosts: a literal could
 * point the egress proxy at the device's own services.
 */
const NUMERIC_LABEL_RE = /\.[0-9]+(?::[0-9]{1,5})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNul(value: string): boolean {
  return value.includes('\0');
}

export function slugifyCheckId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return ID_RE.test(slug) ? slug : 'check';
}

function normalizeCwd(raw: unknown, errors: string[], at: string): string {
  if (raw === undefined || raw === null || raw === '' || raw === '.') return '';
  if (typeof raw !== 'string' || raw.length > VERIFICATION_LIMITS.maxCwdChars || hasNul(raw)) {
    errors.push(`${at}.cwd must be a relative path of at most ${VERIFICATION_LIMITS.maxCwdChars} characters`);
    return '';
  }
  const trimmed = raw.replace(/\/+$/, '').replace(/^\.\//, '');
  if (trimmed.startsWith('/') || trimmed.includes('\\') || trimmed.split('/').some((part) => part === '..' || part === '')) {
    errors.push(`${at}.cwd must stay inside the checkout (no absolute path, no "..")`);
    return '';
  }
  return trimmed;
}

function normalizeNetwork(raw: unknown, errors: string[], at: string): VerificationNetwork {
  if (raw === undefined || raw === null || raw === 'none') return { mode: 'none' };
  if (raw === 'registries') return { mode: 'egress', hosts: [], registries: true };
  if (!isRecord(raw)) {
    errors.push(`${at}.network must be "none", "registries" or { allow: [hosts], registries?: boolean }`);
    return { mode: 'none' };
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'allow' && key !== 'registries') errors.push(`${at}.network.${key} is not a known setting`);
  }
  const allow = raw.allow ?? [];
  const hosts: string[] = [];
  if (!Array.isArray(allow) || allow.length > VERIFICATION_LIMITS.maxHosts) {
    errors.push(`${at}.network.allow must be a list of at most ${VERIFICATION_LIMITS.maxHosts} hosts`);
  } else {
    for (const host of allow) {
      const value = typeof host === 'string' ? host.trim().toLowerCase() : '';
      if (!HOST_RE.test(value)) errors.push(`${at}.network.allow has an invalid host ${JSON.stringify(host)}`);
      else if (NUMERIC_LABEL_RE.test(value)) errors.push(`${at}.network.allow has an IP address ${JSON.stringify(host)}; use a host name`);
      else hosts.push(value);
    }
  }
  if (raw.registries !== undefined && typeof raw.registries !== 'boolean') errors.push(`${at}.network.registries must be a boolean`);
  const registries = raw.registries === true;
  if (hosts.length === 0 && !registries) return { mode: 'none' };
  return { mode: 'egress', hosts: [...new Set(hosts)].sort(), registries };
}

/** A list of check specs: where it sits in the settings (error paths) and its bound. */
interface CheckListKind {
  label: string;
  max: number;
  noun: string;
}

const CHECK_LIST: CheckListKind = { label: 'checks', max: VERIFICATION_LIMITS.maxChecks, noun: 'checks' };
const SETUP_LIST: CheckListKind = { label: 'setup', max: SETUP_LIMITS.maxSteps, noun: 'setup steps' };

function normalizeCheck(raw: unknown, index: number, errors: string[], label: string): VerificationCheckSpec | null {
  const at = `${label}[${index}]`;
  if (!isRecord(raw)) {
    errors.push(`${at} must be an object`);
    return null;
  }
  const known = new Set(['id', 'name', 'run', 'command', 'cwd', 'timeoutSeconds', 'network', 'required']);
  for (const key of Object.keys(raw)) if (!known.has(key)) errors.push(`${at}.${key} is not a known setting`);
  const before = errors.length;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > VERIFICATION_LIMITS.maxNameChars || hasNul(name)) {
    errors.push(`${at}.name must be 1–${VERIFICATION_LIMITS.maxNameChars} characters`);
  }
  let id = slugifyCheckId(name || `check-${index + 1}`);
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) errors.push(`${at}.id must match ${ID_RE.source}`);
    else id = raw.id;
  }
  let argv: string[] = [];
  if (raw.run !== undefined && raw.command !== undefined) errors.push(`${at} must set either "run" or "command", not both`);
  if (raw.run !== undefined) {
    if (typeof raw.run !== 'string' || !raw.run.trim() || raw.run.length > VERIFICATION_LIMITS.maxCommandChars || hasNul(raw.run)) {
      errors.push(`${at}.run must be a non-empty shell command of at most ${VERIFICATION_LIMITS.maxCommandChars} characters`);
    } else {
      argv = ['/bin/sh', '-c', raw.run];
    }
  } else if (raw.command !== undefined) {
    const command = raw.command;
    if (!Array.isArray(command) || command.length === 0 || command.length > VERIFICATION_LIMITS.maxArgv
      || command.some((part) => typeof part !== 'string' || part.length > VERIFICATION_LIMITS.maxCommandChars || hasNul(part))
      || typeof command[0] !== 'string' || !command[0]) {
      errors.push(`${at}.command must be a non-empty argument list (at most ${VERIFICATION_LIMITS.maxArgv} strings)`);
    } else {
      argv = command.map(String);
    }
  } else {
    errors.push(`${at} needs "run" (a shell command) or "command" (an argument list)`);
  }
  const cwd = normalizeCwd(raw.cwd, errors, at);
  let timeoutSeconds: number = VERIFICATION_LIMITS.defaultTimeoutSeconds;
  if (raw.timeoutSeconds !== undefined) {
    const value = raw.timeoutSeconds;
    if (typeof value !== 'number' || !Number.isInteger(value)
      || value < VERIFICATION_LIMITS.minTimeoutSeconds || value > VERIFICATION_LIMITS.maxTimeoutSeconds) {
      errors.push(`${at}.timeoutSeconds must be an integer from ${VERIFICATION_LIMITS.minTimeoutSeconds} to ${VERIFICATION_LIMITS.maxTimeoutSeconds}`);
    } else {
      timeoutSeconds = value;
    }
  }
  const network = normalizeNetwork(raw.network, errors, at);
  if (raw.required !== undefined && typeof raw.required !== 'boolean') errors.push(`${at}.required must be a boolean`);
  if (errors.length > before) return null;
  return { id, name, argv, cwd, timeoutMs: timeoutSeconds * 1000, network, required: raw.required !== false };
}

function normalizeChecks(raw: unknown, errors: string[], kind: CheckListKind = CHECK_LIST): VerificationCheckSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${kind.label} must be a list`);
    return [];
  }
  if (raw.length > kind.max) {
    errors.push(`at most ${kind.max} ${kind.noun} are allowed`);
    return [];
  }
  const checks: VerificationCheckSpec[] = [];
  const ids = new Set<string>();
  raw.forEach((item, index) => {
    const check = normalizeCheck(item, index, errors, kind.label);
    if (!check) return;
    if (ids.has(check.id)) {
      errors.push(`${kind.label}[${index}] repeats the id "${check.id}"`);
      return;
    }
    ids.add(check.id);
    checks.push(check);
  });
  return checks;
}

/**
 * Project settings, strict (unknown keys are errors): what the API accepts on
 * `PUT …/verification-settings` and what the sidecar re-validates from the
 * attempt snapshot. Already-normalized checks (with `argv`) are accepted
 * back as `command` lists, so a stored value round-trips.
 */
export function parseProjectVerificationSettings(raw: unknown): ParseResult<ProjectVerificationSettings> {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['verification settings must be an object'] };
  const known = new Set(['policy', 'checks', 'autoDetect', 'repositoryChecks', 'setup']);
  for (const key of Object.keys(raw)) if (!known.has(key)) errors.push(`${key} is not a known setting`);
  let policy: VerificationPolicy = DEFAULT_VERIFICATION_POLICY;
  if (raw.policy !== undefined) {
    if (!isVerificationPolicy(raw.policy)) errors.push(`policy must be one of ${VERIFICATION_POLICIES.join(', ')}`);
    else policy = raw.policy;
  }
  const checks = normalizeChecks(Array.isArray(raw.checks) ? raw.checks.map(denormalizeCheck) : raw.checks, errors);
  if (raw.autoDetect !== undefined && typeof raw.autoDetect !== 'boolean') errors.push('autoDetect must be a boolean');
  if (raw.repositoryChecks !== undefined && typeof raw.repositoryChecks !== 'boolean') errors.push('repositoryChecks must be a boolean');
  const setup = normalizeChecks(Array.isArray(raw.setup) ? raw.setup.map(denormalizeCheck) : raw.setup, errors, SETUP_LIST);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { policy, checks, autoDetect: raw.autoDetect === true, repositoryChecks: raw.repositoryChecks !== false, setup },
    warnings: [],
  };
}

/**
 * W16a: a `setup` list on its own — the same check rules, at most
 * SETUP_LIMITS.maxSteps steps; stored (normalized) steps are accepted back.
 */
export function parseSetupSteps(raw: unknown): ParseResult<VerificationCheckSpec[]> {
  const errors: string[] = [];
  const steps = normalizeChecks(Array.isArray(raw) ? raw.map(denormalizeCheck) : raw, errors, SETUP_LIST);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: steps, warnings: [] };
}

/** W16a: hash of what a step does (command, directory, network) — "already done in this worktree". */
export function setupStepHash(step: VerificationCheckSpec, hash: (text: string) => string): string {
  return hash(canonicalJson(setupStepIdentity(step)));
}

/**
 * W16a: the setup steps sealed with an attempt (`snapshot.verification`,
 * raw), validated again. Only the `setup` key is read: a problem elsewhere
 * in the settings is verification's concern, never a reason to skip setup.
 * An unreadable `setup` list is a problem (the run fails before the agent
 * starts rather than running in an environment the project did not ask for).
 */
export function resolveSetupPlan(settings: unknown, hash: (text: string) => string): SetupPlan {
  const none: SetupPlan = { steps: [], setupHash: checksHashOf([], hash), problems: [] };
  if (!isRecord(settings) || settings.setup === undefined || settings.setup === null) return none;
  const parsed = parseSetupSteps(settings.setup);
  if (!parsed.ok) return { ...none, problems: parsed.errors };
  return { steps: parsed.value, setupHash: checksHashOf(parsed.value, hash), problems: [] };
}

/** A stored, normalized check (`argv`, `timeoutMs`, network object) back to the input form. */
function denormalizeCheck(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.argv)) return raw;
  const network = isRecord(raw.network) && raw.network.mode === 'egress'
    ? { allow: Array.isArray(raw.network.hosts) ? raw.network.hosts : [], registries: raw.network.registries === true }
    : isRecord(raw.network) && raw.network.mode === 'none' ? 'none' : raw.network;
  return {
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    name: raw.name,
    command: raw.argv,
    ...(typeof raw.cwd === 'string' && raw.cwd ? { cwd: raw.cwd } : {}),
    ...(typeof raw.timeoutMs === 'number' ? { timeoutSeconds: Math.round(raw.timeoutMs / 1000) } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(typeof raw.required === 'boolean' ? { required: raw.required } : {}),
  };
}

/**
 * `.openlinear/checks.json` from the base commit: `{ "checks": [...] }`.
 * Lenient about extra top-level keys (warnings), strict about each check.
 * A `policy` key is ignored: the project, not the repository, decides
 * whether verification gates publication.
 */
export function parseRepositoryChecksFile(text: string): ParseResult<VerificationCheckSpec[]> {
  if (text.length > VERIFICATION_LIMITS.maxConfigBytes) {
    return { ok: false, errors: [`${REPOSITORY_CHECKS_PATH} is larger than ${VERIFICATION_LIMITS.maxConfigBytes} bytes`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: [`${REPOSITORY_CHECKS_PATH} is not valid JSON`] };
  }
  if (!isRecord(parsed)) return { ok: false, errors: [`${REPOSITORY_CHECKS_PATH} must be an object with a "checks" list`] };
  const warnings: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (key === 'checks' || key === '$schema' || key === 'version') continue;
    warnings.push(key === 'policy'
      ? `${REPOSITORY_CHECKS_PATH}: "policy" is ignored (the project's settings decide whether verification gates publication)`
      : `${REPOSITORY_CHECKS_PATH}: unknown key "${key}" ignored`);
  }
  const errors: string[] = [];
  const checks = normalizeChecks(parsed.checks, errors);
  if (errors.length > 0) return { ok: false, errors: errors.map((error) => `${REPOSITORY_CHECKS_PATH}: ${error}`) };
  return { ok: true, value: checks, warnings };
}

// ---------------------------------------------------------------------------
// Auto-detection (opt-in, conservative)
// ---------------------------------------------------------------------------

export interface AutoDetectInput {
  /** package.json at the base commit (null when absent). */
  packageJson: string | null;
  lockfiles: { pnpm: boolean; yarn: boolean; npm: boolean; bun: boolean };
}

const NPM_PLACEHOLDER_TEST = /no test specified/i;

/**
 * Only package.json `typecheck` and `test` scripts (the npm placeholder test
 * script is skipped). With a lockfile, an install step runs first with
 * registry egress and lifecycle scripts disabled; the checks themselves run
 * without network.
 */
export function autoDetectChecks(input: AutoDetectInput): VerificationCheckSpec[] {
  if (!input.packageJson || input.packageJson.length > VERIFICATION_LIMITS.maxConfigBytes * 4) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.packageJson);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return [];
  const scripts = parsed.scripts;
  const manager = input.lockfiles.pnpm ? 'pnpm' : input.lockfiles.yarn ? 'yarn' : input.lockfiles.bun ? 'bun' : 'npm';
  const timeoutMs = VERIFICATION_LIMITS.defaultTimeoutSeconds * 1000;
  const checks: VerificationCheckSpec[] = [];
  const hasLockfile = input.lockfiles.pnpm || input.lockfiles.yarn || input.lockfiles.npm || input.lockfiles.bun;
  if (hasLockfile) {
    const install: Record<string, string[]> = {
      pnpm: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'],
      yarn: ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts'],
      bun: ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'],
      npm: ['npm', 'ci', '--ignore-scripts'],
    };
    checks.push({
      id: 'install',
      name: `Install dependencies (${manager})`,
      argv: install[manager] ?? ['npm', 'ci', '--ignore-scripts'],
      cwd: '',
      timeoutMs,
      network: { mode: 'egress', hosts: [], registries: true },
      required: true,
    });
  }
  for (const script of ['typecheck', 'test']) {
    const body = scripts[script];
    if (typeof body !== 'string' || !body.trim()) continue;
    if (script === 'test' && NPM_PLACEHOLDER_TEST.test(body)) continue;
    checks.push({ id: script, name: script, argv: [manager, 'run', script], cwd: '', timeoutMs, network: { mode: 'none' }, required: true });
  }
  // An install step alone verifies nothing.
  return checks.some((check) => check.id !== 'install') ? checks : [];
}

// ---------------------------------------------------------------------------
// The sealed manifest
// ---------------------------------------------------------------------------

export type VerificationSource = 'project' | 'repository' | 'auto-detect' | 'none';

export interface VerificationManifestInput {
  kind: 'project' | 'repository' | 'auto-detect';
  status: 'used' | 'ignored' | 'absent' | 'invalid' | 'disabled' | 'unavailable';
  /** Content hash of the input as read (sha256 hex), when there was content. */
  sha256: string | null;
  /** Where it was read: the base commit for repository/auto-detect inputs. */
  ref: string | null;
  detail: string | null;
}

export interface VerificationManifest {
  schemaVersion: 1;
  policy: VerificationPolicy;
  policySource: 'project' | 'default';
  source: VerificationSource;
  checks: VerificationCheckSpec[];
  /** sha256 of the canonical JSON of `checks` (the grading input). */
  checksHash: string;
  baseCommit: string | null;
  inputs: VerificationManifestInput[];
  /** Problems that make verification unevaluable (e.g. an invalid repository file). */
  problems: string[];
  warnings: string[];
  capturedAt: string;
}

export interface ResolveManifestInput {
  /** Raw `verification` settings from the attempt snapshot (validated here again). */
  projectSettings: unknown;
  projectSettingsSha256: string | null;
  baseCommit: string | null;
  /** The repository file at the base commit: `null` text = absent; `error` = could not be read. */
  repositoryFile: { text: string | null; sha256: string | null; error?: string } | null;
  /** Auto-detection over the base commit (computed only when needed; see `needsAutoDetect`). */
  autoDetect: () => { checks: VerificationCheckSpec[]; sha256: string | null } | null;
  hash: (text: string) => string;
  now: () => string;
}

/** Deterministic JSON: object keys sorted, arrays in order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function checksHashOf(checks: readonly VerificationCheckSpec[], hash: (text: string) => string): string {
  return hash(canonicalJson(checks));
}

/** Apply the precedence rules; pure apart from the injected hash/clock/auto-detect. */
export function resolveVerificationManifest(input: ResolveManifestInput): VerificationManifest {
  const inputs: VerificationManifestInput[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  let settings: ProjectVerificationSettings | null = null;
  if (input.projectSettings !== null && input.projectSettings !== undefined) {
    const parsed = parseProjectVerificationSettings(input.projectSettings);
    if (parsed.ok) settings = parsed.value;
    else problems.push(...parsed.errors.map((error) => `project verification settings: ${error}`));
  }
  const policy = settings?.policy ?? DEFAULT_VERIFICATION_POLICY;
  const policySource: VerificationManifest['policySource'] = settings ? 'project' : 'default';
  const projectInput: VerificationManifestInput = {
    kind: 'project',
    status: problems.length > 0 ? 'invalid' : settings && settings.checks.length > 0 ? 'used' : 'absent',
    sha256: input.projectSettingsSha256,
    ref: 'project-settings',
    detail: problems.length > 0 ? problems.join('; ') : null,
  };
  const repo = input.repositoryFile;
  const finish = (source: VerificationSource, checks: VerificationCheckSpec[]): VerificationManifest => ({
    schemaVersion: 1,
    policy,
    policySource,
    source,
    checks,
    checksHash: checksHashOf(checks, input.hash),
    baseCommit: input.baseCommit,
    inputs,
    problems,
    warnings,
    capturedAt: input.now(),
  });
  const repositoryInput = (status: VerificationManifestInput['status'], detail: string | null): VerificationManifestInput => ({
    kind: 'repository', status, sha256: repo?.sha256 ?? null, ref: input.baseCommit, detail,
  });

  if (policy === 'off') {
    inputs.push({ ...projectInput, status: 'disabled', detail: 'verification is off for this project' });
    return finish('none', []);
  }
  inputs.push(projectInput);
  if (settings && settings.checks.length > 0) {
    if (repo?.text) inputs.push(repositoryInput('ignored', 'project settings define the checks'));
    return finish('project', settings.checks);
  }
  if (settings && !settings.repositoryChecks) {
    inputs.push(repositoryInput('disabled', 'the project ignores repository check files'));
  } else if (!input.baseCommit || !repo) {
    inputs.push(repositoryInput('unavailable', 'no base commit is known for this workspace'));
  } else if (repo.error) {
    inputs.push(repositoryInput('unavailable', repo.error));
    problems.push(`${REPOSITORY_CHECKS_PATH} could not be read from the base commit: ${repo.error}`);
  } else if (repo.text === null) {
    inputs.push(repositoryInput('absent', null));
  } else {
    const parsed = parseRepositoryChecksFile(repo.text);
    if (!parsed.ok) {
      inputs.push(repositoryInput('invalid', parsed.errors.join('; ')));
      problems.push(...parsed.errors);
      // An invalid file means someone intended checks: never fall back to
      // auto-detection or "no checks" silently.
      return finish('repository', []);
    }
    warnings.push(...parsed.warnings);
    if (parsed.value.length > 0) {
      inputs.push(repositoryInput('used', null));
      return finish('repository', parsed.value);
    }
    inputs.push(repositoryInput('absent', 'the file lists no checks'));
  }
  if (settings?.autoDetect) {
    const detected = input.autoDetect();
    if (detected && detected.checks.length > 0) {
      inputs.push({ kind: 'auto-detect', status: 'used', sha256: detected.sha256, ref: input.baseCommit, detail: null });
      return finish('auto-detect', detected.checks);
    }
    inputs.push({ kind: 'auto-detect', status: 'absent', sha256: detected?.sha256 ?? null, ref: input.baseCommit, detail: 'no package.json typecheck/test script found' });
  }
  return finish('none', []);
}

/** Whether a manifest makes the run enter `verifying` (otherwise running → finishing as before). */
export function manifestRequiresVerification(manifest: VerificationManifest | null | undefined): boolean {
  if (!manifest || manifest.policy === 'off') return false;
  return manifest.checks.length > 0 || manifest.problems.length > 0 || manifest.policy === 'require-pass';
}

// ---------------------------------------------------------------------------
// Results and the publication decision
// ---------------------------------------------------------------------------

export type VerificationCheckStatus = 'passed' | 'failed' | 'timed_out' | 'error' | 'skipped';
/**
 * - `passed`: every required check exited 0 (at least one check ran);
 * - `failed`: a required check exited non-zero or timed out;
 * - `error`: verification could not be evaluated (no pristine checkout,
 *   sandbox unavailable, invalid check definitions, cancelled midway);
 * - `skipped`: nothing to run (no checks configured, or policy `off`).
 */
export type VerificationStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface VerificationCheckResult {
  id: string;
  name: string;
  required: boolean;
  status: VerificationCheckStatus;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  network: 'none' | 'egress';
  /** Display form of the command (argv joined), bounded. */
  command: string;
  log: {
    sha256: string | null;
    bytes: number;
    truncated: boolean;
    /** The output's end, redacted, ≤ VERIFICATION_LIMITS.logTailBytes. */
    tail: string;
    /** Local artifact path (sidecar app data), never sent to the control plane. */
    artifact: string | null;
  };
  /** Why a check could not run (status `error`/`skipped`). */
  detail: string | null;
}

/** Where and how the checks ran: the evidence names the environment, not only the commit. */
export interface VerificationEnvironment {
  sandboxMode: 'enforce' | 'trusted-host' | 'none';
  provider: string | null;
  providerVersion: string | null;
  /** Policy hash per check that ran under the enforced sandbox (env names only, no values). */
  policyHashes: string[];
  platform: string;
  arch: string;
  checkout: 'pristine-clone';
}

export interface VerificationResult {
  schemaVersion: 1;
  status: VerificationStatus;
  commitSha: string;
  baseCommit: string | null;
  checksHash: string;
  policy: VerificationPolicy;
  source: VerificationSource;
  runner: string;
  startedAt: string;
  finishedAt: string;
  checks: VerificationCheckResult[];
  environment: VerificationEnvironment;
  /** Why the status is `error`/`skipped`, if it is. */
  detail: string | null;
  /**
   * Integrity notes, e.g. the agent's commit changed the repository check
   * file (ignored: the base commit's copy was graded) or manifest warnings.
   */
  warnings: string[];
}

/** Display form of a check's argv for logs and evidence: a `/bin/sh -c` line as written, otherwise quoted parts; bounded. */
export function displayCheckCommand(argv: readonly string[], maxChars = 400): string {
  const shell = argv.length === 3 && argv[0] === '/bin/sh' && argv[1] === '-c';
  const text = shell ? argv[2] ?? '' : argv.map((part) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** The overall status from per-check results (non-required checks never fail verification). */
export function summarizeVerification(checks: readonly VerificationCheckResult[]): VerificationStatus {
  const required = checks.filter((check) => check.required);
  if (checks.length === 0) return 'skipped';
  if (required.some((check) => check.status === 'failed' || check.status === 'timed_out')) return 'failed';
  if (required.some((check) => check.status === 'error' || check.status === 'skipped')) return 'error';
  if (required.length === 0) return checks.some((check) => check.status === 'passed') ? 'passed' : 'error';
  return 'passed';
}

export interface PublicationDecision {
  allowed: boolean;
  /** Short reason recorded with the decision. */
  reason: string;
}

export function verificationPublicationDecision(policy: VerificationPolicy, status: VerificationStatus): PublicationDecision {
  if (policy === 'off') return { allowed: true, reason: 'verification is off for this project' };
  if (policy === 'warn') {
    return status === 'passed'
      ? { allowed: true, reason: 'verification passed' }
      : { allowed: true, reason: `verification ${status === 'skipped' ? 'had no checks to run' : status}; publishing anyway (policy: warn)` };
  }
  if (status === 'passed') return { allowed: true, reason: 'verification passed (policy: require-pass)' };
  return {
    allowed: false,
    reason: status === 'skipped'
      ? 'the project requires passing verification but no checks are configured'
      : `verification ${status}; the project requires passing verification`,
  };
}

/** One line for logs and outcomes, e.g. "2 of 3 required checks failed on abc1234". */
export function describeVerification(result: Pick<VerificationResult, 'status' | 'commitSha' | 'checks' | 'detail'>): string {
  const sha = result.commitSha.slice(0, 12);
  const required = result.checks.filter((check) => check.required);
  const passed = required.filter((check) => check.status === 'passed').length;
  switch (result.status) {
    case 'passed':
      return `Verification passed on ${sha} (${passed}/${required.length} required check${required.length === 1 ? '' : 's'})`;
    case 'failed': {
      const failed = required.filter((check) => check.status === 'failed' || check.status === 'timed_out').length;
      return `Verification failed on ${sha}: ${failed} of ${required.length} required check${required.length === 1 ? '' : 's'} failed`;
    }
    case 'error':
      return `Verification could not be completed on ${sha}${result.detail ? `: ${result.detail}` : ''}`;
    case 'skipped':
      return `No verification checks ran on ${sha}${result.detail ? ` (${result.detail})` : ''}`;
  }
}
