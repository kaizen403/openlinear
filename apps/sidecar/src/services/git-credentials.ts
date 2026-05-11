import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ExecFileOptions } from 'child_process';
import { execFileAsync, type ExecFileResult } from './execution/exec';

interface GitCredentialConfig {
  args: string[];
  cleanup: () => void;
}

function getCredentialUrl(accessToken: string, remoteUrl?: string): string {
  const encodedToken = encodeURIComponent(accessToken);

  if (remoteUrl) {
    try {
      const url = new URL(remoteUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        return `${url.protocol}//oauth2:${encodedToken}@${url.host}`;
      }
    } catch {
      // Fall through to GitHub, which is the only token-backed provider today.
    }
  }

  return `https://oauth2:${encodedToken}@github.com`;
}

export function createGitCredentialConfig(accessToken: string | null, remoteUrl?: string): GitCredentialConfig {
  if (!accessToken) {
    return { args: [], cleanup: () => undefined };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'openlinear-git-'));
  const credentialsFile = join(tempDir, 'credentials');
  writeFileSync(credentialsFile, `${getCredentialUrl(accessToken, remoteUrl)}\n`, { mode: 0o600 });

  return {
    args: ['-c', `credential.helper=store --file=${credentialsFile}`],
    cleanup: () => {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export async function execGitWithCredentials(
  args: ReadonlyArray<string>,
  accessToken: string | null,
  remoteUrl?: string,
  options: ExecFileOptions = {},
): Promise<ExecFileResult> {
  const credentials = createGitCredentialConfig(accessToken, remoteUrl);
  try {
    return await execFileAsync('git', [...credentials.args, ...args], options);
  } finally {
    credentials.cleanup();
  }
}
