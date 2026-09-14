import { z } from 'zod';

/**
 * Validators for values that reach `git` as arguments, or reach the filesystem
 * as paths, on a user's machine.
 *
 * These are security boundaries, not formatting niceties. The sidecar passes
 * `cloneUrl`, `defaultBranch` and `localPath` straight through to
 * `git clone` / `git worktree add` / `git checkout`, in **positional** slots.
 * Two concrete consequences of the previous `z.string()` typings:
 *
 *   - a stored "clone URL" using git's `ext::` transport makes `git clone`
 *     execute an attacker-chosen program as the desktop user;
 *   - a branch name beginning with `-` is parsed by git as an option rather
 *     than a ref.
 */

/** Hosts we are willing to clone from. */
function allowedGitHosts(): string[] {
  const configured = process.env.GITHUB_HOST?.trim();
  return configured ? ['github.com', configured.toLowerCase()] : ['github.com'];
}

/**
 * A git ref name safe to pass positionally.
 *
 * Rejects a leading `-` (option injection), a leading `/` or `.`, `..`,
 * `/.`, and trailing `.` or `/`. The character class matches git's own
 * check-ref-format rules closely enough for branch names we create or accept.
 */
export const gitRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^(?![-/.])(?!.*\.\.)(?!.*\/\.)(?!.*\.$)(?!.*\/$)[A-Za-z0-9._/-]+$/,
    'Invalid git ref name',
  );

/**
 * An HTTPS clone URL on an allowlisted host.
 *
 * Only `https:` is permitted — never `ext::`, `file://`, `ssh://` or `git://`.
 */
export const gitHttpsUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a valid URL' });
      return;
    }

    if (url.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only https:// clone URLs are supported',
      });
      return;
    }

    if (url.username || url.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Clone URL must not embed credentials',
      });
      return;
    }

    if (!allowedGitHosts().includes(url.hostname.toLowerCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Clone URL host must be one of: ${allowedGitHosts().join(', ')}`,
      });
      return;
    }

    if (!/^\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/.test(url.pathname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Clone URL path must be /<owner>/<repo>',
      });
    }
  });

/**
 * An absolute local repository path.
 *
 * Blocks relative paths, `..` traversal, and the URL-ish and null-byte forms
 * that defeat naive path handling. The sidecar performs the authoritative
 * checks (realpath, `.git` presence, user-configured allowlist); this stops the
 * obviously-hostile shapes at the API boundary.
 */
export const localRepoPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/'), 'Local path must be absolute')
  .refine((value) => !value.includes('\0'), 'Local path must not contain null bytes')
  .refine(
    (value) => !value.split('/').includes('..'),
    'Local path must not contain ".." segments',
  )
  .refine(
    (value) => !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value),
    'Local path must be a filesystem path, not a URL',
  );
