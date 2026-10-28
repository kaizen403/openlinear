import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApprovalMode, SandboxMode } from '@openai/codex-sdk';
import { executableFile } from '../shared/binary';

/**
 * The `codex exec --experimental-json` contract, mirrored from
 * `@openai/codex-sdk` 0.164.0 (`dist/index.js`, class CodexExec). The SDK
 * spawns the CLI itself with no hook for a wrapper, so W07 launches the same
 * argv under the SandboxProvider and keeps the SDK for its event types and
 * its version-matched vendored binary (`@openai/codex` 0.164.0).
 */
export const CODEX_SDK_VERSION = '0.164.0';

const PLATFORM_PACKAGE_BY_TARGET: Readonly<Record<string, string>> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
};

export function codexTargetTriple(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'linux' || platform === 'android') {
    if (arch === 'x64') return 'x86_64-unknown-linux-musl';
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return 'x86_64-apple-darwin';
    if (arch === 'arm64') return 'aarch64-apple-darwin';
  }
  return null;
}

export interface CodexBinary {
  path: string;
  /** Helper dirs the SDK prepends to PATH (bundled `rg`). */
  pathDirs: string[];
  /** Directory that must be readable inside the sandbox (vendored target root). */
  readRoot: string | null;
  version: string | null;
  source: 'override' | 'sdk-vendored';
}

function findPackageDir(fromDir: string, name: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return realpathSync.native(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * `OPENLINEAR_CODEX_PATH` (absolute, executable) wins; otherwise the binary
 * vendored with the pinned SDK, resolved exactly as the SDK does. Throws with
 * an actionable message when neither exists.
 */
export function resolveCodexBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  fromDir: string = moduleDir(),
): CodexBinary {
  const override = env.OPENLINEAR_CODEX_PATH;
  if (override) {
    const path = executableFile(override);
    if (!path) throw new Error('OPENLINEAR_CODEX_PATH must be an absolute path to an executable codex binary');
    return { path, pathDirs: [], readRoot: null, version: null, source: 'override' };
  }
  const triple = codexTargetTriple(platform, arch);
  const platformPackage = triple ? PLATFORM_PACKAGE_BY_TARGET[triple] : undefined;
  if (!triple || !platformPackage) throw new Error(`Codex has no vendored binary for ${platform} (${arch})`);
  const sdkDir = findPackageDir(fromDir, '@openai/codex-sdk');
  if (!sdkDir) throw new Error('@openai/codex-sdk is not installed next to the sidecar');
  let vendorRoot: string;
  try {
    const codexPackageJson = createRequire(join(sdkDir, 'package.json')).resolve('@openai/codex/package.json');
    const platformPackageJson = createRequire(codexPackageJson).resolve(`${platformPackage}/package.json`);
    vendorRoot = join(dirname(platformPackageJson), 'vendor', triple);
  } catch {
    throw new Error('Unable to locate the Codex CLI binary. Ensure @openai/codex is installed with optional dependencies.');
  }
  const layouts: Array<{ binary: string; pathDir: string; manifest: string | null }> = [
    { binary: join(vendorRoot, 'bin', 'codex'), pathDir: join(vendorRoot, 'codex-path'), manifest: join(vendorRoot, 'codex-package.json') },
    { binary: join(vendorRoot, 'codex', 'codex'), pathDir: join(vendorRoot, 'path'), manifest: null },
  ];
  for (const layout of layouts) {
    if (layout.manifest && !existsSync(layout.manifest)) continue;
    const path = executableFile(layout.binary);
    if (!path) continue;
    let version: string | null = null;
    if (layout.manifest) {
      try {
        const manifest = JSON.parse(readFileSync(layout.manifest, 'utf8')) as { version?: unknown };
        version = typeof manifest.version === 'string' ? manifest.version : null;
      } catch {
        version = null;
      }
    }
    return {
      path,
      pathDirs: isDir(layout.pathDir) ? [realpathSync.native(layout.pathDir)] : [],
      readRoot: realpathSync.native(vendorRoot),
      version,
      source: 'sdk-vendored',
    };
  }
  throw new Error(`Unable to locate Codex CLI binaries for ${triple}. Ensure @openai/codex is installed with optional dependencies.`);
}

export interface CodexExecArgs {
  model?: string;
  sandboxMode: SandboxMode;
  workingDirectory: string;
  skipGitRepoCheck?: boolean;
  approvalPolicy?: ApprovalMode;
  threadId?: string | null;
}

/** Argument vector in the SDK's order (flags, then `resume <id>`). */
export function buildCodexExecArgs(args: CodexExecArgs): string[] {
  const out = ['exec', '--experimental-json'];
  if (args.model) out.push('--model', args.model);
  out.push('--sandbox', args.sandboxMode);
  out.push('--cd', args.workingDirectory);
  if (args.skipGitRepoCheck) out.push('--skip-git-repo-check');
  if (args.approvalPolicy) out.push('--config', `approval_policy="${args.approvalPolicy}"`);
  if (args.threadId) out.push('resume', args.threadId);
  return out;
}
