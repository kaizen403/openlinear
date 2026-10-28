import { apiFetch } from './fetch';

/**
 * W11a project verification settings and W10a GitHub App status (API).
 * Shapes mirror `apps/api/src/services/execution-verification.ts` and
 * `github-app-credentials.ts` (`describeProjectGitHubApp`). W16a: the same
 * settings carry the environment setup steps (`setup`, check format).
 */

export type VerificationPolicy = 'require-pass' | 'warn' | 'off';

export type VerificationNetwork = { mode: 'none' } | { mode: 'egress'; hosts: string[]; registries: boolean };

/** A normalized check as the server stores it (`argv`, never re-parsed). */
export interface VerificationCheckSpec {
  id: string;
  name: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  network: VerificationNetwork;
  required: boolean;
}

export interface ProjectVerificationSettings {
  policy: VerificationPolicy;
  checks: VerificationCheckSpec[];
  autoDetect: boolean;
  repositoryChecks: boolean;
  /** W16a: run in the worktree before the agent starts (absent from older APIs). */
  setup?: VerificationCheckSpec[];
}

export interface ProjectVerificationSettingsView {
  projectId: string;
  configured: boolean;
  settings: ProjectVerificationSettings;
  checksHash: string;
  /** W16a (absent from older APIs). */
  setupHash?: string;
}

/** The input form `PUT` accepts (execution-core `parseProjectVerificationSettings`). */
export interface VerificationCheckInput {
  id?: string;
  name: string;
  run?: string;
  command?: string[];
  cwd?: string;
  timeoutSeconds?: number;
  network?: 'none' | 'registries' | { allow?: string[]; registries?: boolean };
  required?: boolean;
}

export interface ProjectVerificationSettingsInput {
  policy: VerificationPolicy;
  checks: VerificationCheckInput[];
  autoDetect: boolean;
  repositoryChecks: boolean;
  /** W16a: at most 10 steps; omitted = the stored steps are kept, [] clears them. */
  setup?: VerificationCheckInput[];
}

export function fetchProjectVerificationSettings(projectId: string): Promise<ProjectVerificationSettingsView> {
  return apiFetch<ProjectVerificationSettingsView>(`/api/projects/${encodeURIComponent(projectId)}/verification-settings`);
}

export function saveProjectVerificationSettings(projectId: string, body: ProjectVerificationSettingsInput): Promise<ProjectVerificationSettingsView> {
  return apiFetch<ProjectVerificationSettingsView>(`/api/projects/${encodeURIComponent(projectId)}/verification-settings`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export interface ProjectGitHubAppStatus {
  projectId: string;
  repository: string | null;
  configured: boolean;
  installed: boolean | null;
  suspended: boolean | null;
  installationId: number | null;
  account: { login: string | null; type: string | null } | null;
  repositorySelection: string | null;
  missingPermissions: string[];
  installUrl: string | null;
  manageUrl: string | null;
  fallbackPolicy: 'user_oauth' | 'deny';
}

export function fetchProjectGitHubApp(projectId: string): Promise<ProjectGitHubAppStatus> {
  return apiFetch<ProjectGitHubAppStatus>(`/api/github-app/projects/${encodeURIComponent(projectId)}/installation`);
}
