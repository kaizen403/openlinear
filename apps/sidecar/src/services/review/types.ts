/**
 * Response contract of `GET /api/tasks/:id/diff` (the desktop review panel
 * is built against these exact field names — do not rename them).
 *
 * Everything in a DiffLine/DiffFile is untrusted worktree content carried
 * as plain strings; nothing here is ever interpreted.
 */

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  oldNo?: number;
  newNo?: number;
  text: string;
  /** line text was cut at maxLineChars */
  truncated?: true;
  /** "\ No newline at end of file" followed this line */
  noEol?: true;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  truncated?: true;
  similarity?: number;
  untracked?: true;
}

export type TaskDiffSource = 'legacy-live' | 'v2' | 'legacy-disk';

export interface TaskDiffLimits {
  maxFiles: number;
  maxLinesPerFile: number;
  maxTotalLines: number;
  maxLineChars: number;
  maxPatchBytes: number;
  maxUntrackedFileBytes: number;
}

export interface TaskDiffResponse {
  /** ref = how base was chosen, e.g. 'origin/main', 'main', 'HEAD', 'fork-point', 'empty', or the user-supplied value */
  base: { ref: string; sha: string };
  /** ref = current branch (null if detached), sha = HEAD commit (null before the first commit), dirty = uncommitted/untracked changes are included */
  head: { ref: string | null; sha: string | null; dirty: boolean };
  /** sha256 hex fingerprint of base.sha + head.sha + the raw diff bytes + untracked file contents (stable when nothing changed) */
  revision: string;
  source: TaskDiffSource;
  files: DiffFile[];
  /** any limit hit anywhere (files list cut, a file cut, patch bytes cut) */
  truncated: boolean;
  /** files/additions/deletions are totals over ALL changed files (from numstat) even when the list was truncated */
  stats: {
    files: number;
    additions: number;
    deletions: number;
    shownFiles: number;
    binaryFiles: number;
    untrackedFiles: number;
  };
  limits: TaskDiffLimits;
}

/** Where a task's attempt checkout lives on this device (workspace-resolver.ts). */
export interface ResolvedTaskWorkspace {
  worktreePath: string;
  /** The attempt branch recorded for the run (informational; the diff reports the live HEAD). */
  branch: string | null;
  /** The repository default branch the attempt started from, when known. */
  baseRef: string | null;
  /** The principal that started the run, when known (null: authorize through the control plane). */
  ownerUserId: string | null;
  source: TaskDiffSource;
}
