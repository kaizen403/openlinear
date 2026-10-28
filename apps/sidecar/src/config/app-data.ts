import { homedir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';

/**
 * The sidecar's per-user data directory: run journal, models.dev catalogue
 * cache, worktrees, sandbox roots and (by default) cloned repositories.
 *
 * 1. `OPENLINEAR_APP_DATA` when set and non-empty (resolved to an absolute path).
 * 2. macOS: `~/Library/Application Support/OpenLinear`.
 * 3. Windows: `%LOCALAPPDATA%\OpenLinear` (default `~\AppData\Local\OpenLinear`).
 * 4. Linux and other Unix: `$XDG_DATA_HOME/openlinear`, default
 *    `~/.local/share/openlinear`. Per the XDG Base Directory spec an empty or
 *    relative `XDG_DATA_HOME` is ignored.
 *
 * The desktop launcher (apps/desktop/src-tauri/src/sidecar.rs) forwards `HOME`
 * and `XDG_*` unchanged, so a launched sidecar resolves the same base
 * directory as the launcher's own Tauri data dir (`$XDG_DATA_HOME/com.openlinear.app`
 * on Linux) without the launcher having to pass a path.
 *
 * Before 2026-10-26 the journal and catalogue defaulted to the macOS path on
 * every platform (`~/Library/Application Support/OpenLinear` on Linux), while
 * worktrees and the sandbox used the XDG path.
 */
export function sidecarAppDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = env.OPENLINEAR_APP_DATA;
  if (explicit) return resolve(explicit);

  if (platform === 'win32') {
    const local = env.LOCALAPPDATA && win32.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : win32.join(homedir(), 'AppData', 'Local');
    return win32.join(local, 'OpenLinear');
  }
  const home = env.HOME || homedir();
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'OpenLinear');
  const xdgDataHome = env.XDG_DATA_HOME && posix.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : posix.join(home, '.local', 'share');
  return posix.join(xdgDataHome, 'openlinear');
}
