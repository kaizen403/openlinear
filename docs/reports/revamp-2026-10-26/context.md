# W16b — versioned repository context + FE-11 related files

Date: 2026-10-27. Status: **implemented and locally validated; not committed,
not deployed, not yet wired into the run prompt** (the coordinator owns
`run/service.ts` / `run/index.ts`; the snippet is in §8). No model inference
anywhere: indexing, ranking and the ablation are lexical and offline.

## 1. Problem

The agent starts every run cold: the prompt is the task title, description
and labels, and the agent spends its first turns searching the repository.
PRD W16: "Repo SHA/content hashes in index; scoped retrieval and
invalidation; … prompt-injection boundary; context benefit demonstrated with
ablation". FE-11 also asked for suggestions with repository citations in the
task view.

## 2. What was built

### 2.1 Index (`apps/sidecar/src/context/repo-index.ts`, `git.ts`, `extract.ts`, `tokenize.ts`)

- Built from **one commit's objects**, never a working tree:
  `git ls-tree -r -z <sha>` (regular files; symlinks and submodules left
  out), sizes from `git cat-file --batch-check`, content from
  `git cat-file --batch`. Setup steps, the agent or uncommitted edits cannot
  change what the index says about that commit.
- Keyed by the **commit SHA**; every file carries its **blob SHA** (content
  hash). The analysis of a blob is reused from the repository's previous
  index when the blob is unchanged (incremental reuse across commits).
- All git runs through the sidecar's hardened git (config scan, no hooks,
  filters, helpers, user config) with **`GIT_NO_LAZY_FETCH=1`**: in the
  blobless mirrors (`--filter=blob:none`) a blob that was never materialised
  is reported missing and the file is indexed **by path only** — nothing is
  fetched. (Found while testing: `ls-tree -l` would lazily fetch every blob
  for its size column; it is not used.)
- Skipped: vendored/generated trees (node_modules, dist, build, .next,
  vendor, target, coverage, caches, …), minified/generated files, lockfiles,
  secret-looking files (`.env*`, `*.pem`/`*.key`/`*.p12`…, `id_rsa*`,
  `.npmrc`, `credentials*`, `secrets.{json,yaml,…}`, service-account JSON,
  `.ssh/.aws/.gnupg` dirs), binaries (extension list + NUL sniff), files
  over 512 KB, paths with control/bidi characters or `<`, `>`, `` ` ``.
  Caps: 20,000 files, 64 MB of content per build (beyond it: path only).
- Per blob: line count, token count, declared symbols (regex per language:
  TS/JS, Python, Go, Rust, Java/Kotlin, Ruby, Markdown headings, Prisma,
  GraphQL, SQL; ≤ 64 per file) and its 400 most frequent content terms.
- Tokens: identifiers split on case/`_`/`-`/digits, plus the joined form of
  multi-part identifiers (an exact `resolveTaskWorkspace` mention matches);
  stop words; a small deterministic stemmer (cache/caches/cached/caching →
  one term). Task text additionally drops work words (fix, add, bug, …).

### 2.2 Retrieval (`retrieve.ts`)

- BM25 per field — file name, folder, declared symbols, content — each
  saturated on its own, then weighted (2 / 0.6 / 1.2 / 1): a term in a file's
  name or declarations counts more than any number of mentions in its text.
  Title terms count twice; ≤ 48 query terms.
- A file the task names by path (`src/auth/session.ts`, `invoice.ts`) gets a
  fixed bonus. Tests ×0.5 and Markdown/text ×0.6 unless the task is about
  tests/docs.
- Deterministic (ties on path). Results below 25 % of the best score are
  not offered. Each result has reasons ("declares refreshAccessToken",
  "file name: session", "mentions token, renew") and the matched task words.
- Excerpt: the window of ≤ 14 lines with the most matched terms (a matching
  declaration counts extra), starting two lines above the first match.

### 2.3 Cache (`cache.ts`)

- `<app data>/context-index/<hash(repository identity)>/<commit>.json`. The
  app data dir is in every agent sandbox's deny list. Repository identity =
  `repositoryKeyFor(snapshot)`: `repo:<fullName>` or `local:<localPath>`, the
  same for runs and the route, so either warms the other.
- **Invalidation is by SHA**: a commit's index never changes; a new commit is
  a new file. Directories 0700, files 0600, atomic write (temp + rename); a
  root that is a symlink or owned by someone else is not used. A file that
  does not parse/validate (zod; wrong version or commit) is deleted and the
  index rebuilt. LRU by mtime (touched on every hit), ≤ 32 entries and
  ≤ 256 MB; stale temp files swept.
- In memory: the last 3 prepared indexes. Builds: one per key at a time
  (shared), one at a time per process, each bounded to 120 s. A caller waits
  at most its own timeout (prompt 20 s, route 8 s) and otherwise gets
  "still indexing" while the build finishes for the next call.

### 2.4 Prompt section and the prompt-injection boundary (`prompt.ts`, `index.ts`)

`repositoryContextFor({ worktreePath, commitSha, repositoryKey, task, maxChars?, signal? })`
→ `{ section | null, citations, receipt: { sha, indexedFiles, contentFiles, cacheHit, reusedBlobs, ms }, reason }`.
**Never throws**: no repository/commit, cancelled, still indexing, nothing
related, over budget or any error → `section: null` + reason.

- Every excerpt sits in the same `<untrusted-repository-content>` envelope as
  a follow-up's previous diff (execution-core `wrapUntrustedRepositoryContent`;
  envelope tags inside the content are neutralised), with a source attribute
  `path:start-end@sha12`. The section says before and after that it is
  repository data, never instructions, and to open the files before relying
  on an excerpt.
- Every content line is line-numbered (`120| …`), so no repository line can
  start a prompt line: no fence, heading or tag can be closed or opened.
- Control characters, ANSI escapes, zero-width and bidi characters are
  removed; lines cut at 200 chars; secret-looking strings redacted
  (`redactSecrets` from the run journal plus AWS/Google/Slack/Stripe/npm/
  GitLab key shapes and quoted `password|token|secret = "…"`); paths
  JSON-quoted with `<`/`>` escaped.
- Hard budget (`OPENLINEAR_REPO_CONTEXT_MAX_CHARS`, 1,000–20,000, default
  6,000): excerpts shortened (halved down to 3 lines), then listed by path,
  then left out; the section length never exceeds the budget.
- Up to 6 files. `describeContextReceipt(result)` gives a log line:
  `Repository context: 6 related files at 9b1c… (cached index 1567 files, 224 ms)`.

### 2.5 Route (`apps/sidecar/src/routes/repo-context.ts`, mounted in `app.ts`)

`GET /api/tasks/:id/related-files` (per-route `requireSidecarAuth`, like the
diff route). Reads the task and its project **as the caller** from the
control plane (view access; 401/403/404 pass through, unreachable → 503),
then indexes the project's **local folder at HEAD** (must be the repository
root, outside OpenLinear storage), else the sidecar's **mirror** of the
linked repository at `refs/remotes/origin/<default branch>` — the commits
runs start from. Never clones or fetches. Always 200 once the task is
readable: `status` `ready` | `indexing` (+ `retryAfterMs`) | `unavailable`
(+ reason, e.g. "has not been cloned on this device yet") | `disabled`.
Citations only (path, lines, score, reasons, matched) — no file content.

### 2.6 Desktop (FE-11)

- `lib/api/repo-context.ts` (`fetchRelatedFiles`), route row in
  `lib/api/routes.ts` `SIDECAR_ROUTES` + `routes.test.mjs` cases.
- `components/related-files.tsx`: "Related files" in the task sidebar under
  Dependencies — path, `L4–17`, "matched: access, token, renew", reasons on
  hover. Silent when unavailable/disabled/empty/unreachable; polls while
  `indexing`; the query key includes a fingerprint of title/description/
  labels so edits refetch. Key used in-component:
  `['ol','tasks','detail',taskId,'related-files',{ revision }]` (under the task
  detail prefix).

### 2.7 Settings

`OPENLINEAR_REPO_CONTEXT=0|false|off|no` turns both the prompt section and
the route off (route answers `disabled`); on by default.
`OPENLINEAR_REPO_CONTEXT_MAX_CHARS` bounds the prompt section.

## 3. Ablation (PRD: "context benefit demonstrated with ablation")

Offline, deterministic, no model. `src/context/ablation.test.ts` builds a
made-up repository (`fixtures/ablation-corpus.ts`: 42 indexed files — TS API
and web app, Go worker, Python models, Rust CLI, docs, tests; a lockfile and
`.env.example` that must be skipped) and 18 tasks written as people file
them, each labelled with the file(s) to change. Most describe the symptom in
words the path does not contain ("Users get logged out after an hour" →
`src/auth/session.ts`). Each mode ranks the files; top 5:

| Mode | P@5 | R@5 | MRR | hit@5 |
|---|---|---|---|---|
| path only (name + folder) | 0.144 | 0.639 | 0.602 | 12/18 |
| path + declared symbols | 0.211 | 0.972 | 0.817 | 18/18 |
| **full** (+ content terms, production) | **0.222** | **1.000** | **0.972** | **18/18** |

(P@5 is capped near 0.22: tasks have 1–2 relevant files.) The test asserts
full ≥ path-only on MRR and R@5, full ≥ path+symbols on MRR, and floors
(MRR ≥ 0.8, R@5 ≥ 0.9) so ranking regressions fail CI.

Informal second check (not in CI): a snapshot of this repository's working
tree (1,567 indexed files) and 12 tasks from this revamp's log, labelled by
me with the file I changed or would change:

| Mode | R@5 | MRR |
|---|---|---|
| path only | 0.647 | 0.542 |
| path + symbols | 0.824 | 0.667 |
| full | 0.882 | 0.639 |

Content helps recall here too; MRR is slightly below path+symbols (long
ledgers and tests that mention everything compete; the test/doc priors were
added after a first run where full scored MRR 0.30). Caveats for both: the
corpus, labels and scorer were written by the same person, retrieval quality
≠ agent success, and the end-to-end benefit (fewer agent turns/tokens, more
verified runs with vs. without the section) still needs the W21 harness
with paid inference — not run.

Timings on this machine (M-series, the 1,567-file snapshot): cold build
1.6–1.9 s (20 MB read), disk-cache hit 224 ms in a fresh process, memory hit
~50 ms; cache file 4.4 MB.

## 4. Tests

- `src/context/context.test.ts` (34): tokenizer/stemmer, path mentions,
  file eligibility (16 cases), symbol extraction for 7 languages, term cap,
  ranking determinism, priors, modes, excerpts, prompt boundary (closing-tag
  injection, line numbers, fences, redaction, ANSI/bidi, budget never
  exceeded over 6 budgets, shorten → list → null), settings, cache key.
- `src/context/context.realgit.test.ts` (6, real git): commit objects not
  the working tree, blob ids, skips (vendored, lockfile, 2 secrets, binary
  content, symlink); blobless clone → path only and **nothing fetched even
  with the file transport allowed**; prompt end to end, receipt, owner-only
  modes, memory/disk cache hits, new commit = new entry with 2 reused blobs;
  corrupt cache rebuilt; LRU eviction; hostile file (closing tag + "SYSTEM:"
  + Stripe key) stays inside; never-throws cases (missing dir, foreign SHA,
  `HEAD` as SHA, abort, timeout → indexing → ready, no searchable words).
- `src/context/ablation.test.ts` (2): §3.
- `src/routes/repo-context.test.ts` (9): 401; local folder at HEAD (no
  content in the body, no-store); mirror at default branch; unavailable
  reasons (not cloned, folder gone, no project); disabled; indexing →
  retry → ready; 403/404 pass-through; folder inside storage / not the root /
  relative / bad branch refused; task + project read as the caller.
- Desktop `components/related-files.test.mjs` (7): list with ranges and
  matched words; silent when unavailable/disabled/no match/unreachable;
  polls while indexing; refetches on task edits. `routes.test.mjs` +3 cases.

Validation: sidecar typecheck ✓; sidecar suite 91 files, 1269 passed + 4
skipped; desktop-ui typecheck ✓; desktop-ui unit suite 94 files, 1203 passed
+ 9 skipped; `biome check --error-on-warnings` on the new sidecar files ✓.

## 5. Limits / follow-ups

- **Not in the prompt yet**: needs the §8 lines in `run/service.ts` and
  `run/index.ts`. Follow-up turns get no section (their seeded prompt is
  already large).
- Lexical only: no embeddings, no call graph or import graph; synonyms
  ("profile picture" vs "avatar") work only through words the code uses.
- A blob reused across paths keeps the first path's language for symbols.
- Mirrors only advance when a run fetches; the route shows the commit it
  used. A repository never run on this device (and no local folder) gets
  `unavailable`.
- Very large repositories: content beyond 64 MB / 20,000 files is path-only;
  a build over 120 s fails and the caller sees `unavailable`.
- Local-folder repositories whose own git config has keys outside the
  sidecar allowlist (e.g. LFS filters) are refused by the hardened git, as
  for runs.
- No agent-run ablation (needs paid inference, W21).

## 6. Files

New: `apps/sidecar/src/context/{index,repo-index,retrieve,prompt,cache,git,extract,tokenize}.ts`,
`apps/sidecar/src/context/fixtures/ablation-corpus.ts`,
`apps/sidecar/src/context/{context.test,context.realgit.test,ablation.test}.ts`,
`apps/sidecar/src/routes/repo-context.ts`, `apps/sidecar/src/routes/repo-context.test.ts`,
`apps/desktop-ui/lib/api/repo-context.ts`, `apps/desktop-ui/components/related-files.tsx`,
`apps/desktop-ui/components/related-files.test.mjs`, this ledger.
Edited: `apps/sidecar/src/app.ts` (import + mount), `apps/desktop-ui/lib/api/routes.ts`
(one row), `apps/desktop-ui/lib/api/routes.test.mjs` (module, case, 2 table
rows, documented list), `apps/desktop-ui/components/task-detail-view.tsx`
(import + `<RelatedFilesSection>` under Dependencies).

## 7. Requests for files owned by others

- `apps/desktop-ui/lib/query/keys.ts` (optional): `relatedFiles: (taskId: string, revision: string) => ['ol', 'tasks', 'detail', taskId, 'related-files', { revision }] as const`
  — then use it in `components/related-files.tsx`.
- `run/service.ts` / `run/index.ts`: §8.

## 8. Integration snippet (coordinator)

`run/service.ts`:

```ts
import { describeContextReceipt, repositoryKeyFor, type RepositoryContextInput, type RepositoryContextResult } from '../context';

// RunServiceDeps:
  /**
   * W16b: bounded "Repository context" for the prompt (related files with
   * excerpts from the base commit). Absent = no section. Never throws.
   */
  repositoryContext?: (input: RepositoryContextInput) => Promise<RepositoryContextResult>;

// prepare(): after `await this.runSetup(run, workspace); this.checkpoint(run);`
// and before `this.progress(run, 'executing', 'Starting agent...')`:
    // W16b: repository context from the base commit (never fails the run).
    let repositoryContext: string | null = null;
    const contextPort = this.deps.repositoryContext;
    if (!followUp && contextPort) {
      const snapshot = this.refresh(run).snapshot;
      const context = await this.step(run.runId, 'prepare:repository-context', () => contextPort({
        worktreePath: workspace.worktreePath,
        commitSha: workspace.baseCommit ?? null,
        repositoryKey: repositoryKeyFor(snapshot),
        task: { title: snapshot.title, description: snapshot.description, labels: snapshot.labels },
        signal: run.controller.signal,
      }));
      repositoryContext = context.section;
      this.log(run, 'info', describeContextReceipt(context));
      this.checkpoint(run);
    }

// runtime.start({... prompt: this.promptFor(run, repositoryContext), ...})

  private promptFor(run: ActiveRun, repositoryContext: string | null = null): string {
    const snapshot = run.record.snapshot;
    let prompt = snapshot.title;
    if (snapshot.description) prompt += `\n\n${snapshot.description}`;
    if (snapshot.labels.length > 0) prompt += `\n\nLabels: ${snapshot.labels.join(', ')}`;
    if (repositoryContext) prompt += `\n\n${repositoryContext}`;
    return prompt;
  }
```

`run/index.ts` (production wiring; existing tests construct `RunService`
without the dep, so nothing changes for them):

```ts
import { repositoryContextFor, repositoryContextSettings, type RepositoryContextInput } from '../context';
// in new RunService({ ... }):
    // W16b: on by default; OPENLINEAR_REPO_CONTEXT=0 turns it off.
    ...(repositoryContextSettings().enabled
      ? { repositoryContext: (input: RepositoryContextInput) => repositoryContextFor({ ...input, maxChars: repositoryContextSettings().maxChars }) }
      : {}),
```

Where the values come from: `workspace` is the `RunWorkspace` journaled in
`prepare` (`worktreePath`; `baseCommit` = the commit the checkout was created
at, before setup or the agent — null only for very old journal rows, then
HEAD is used); `snapshot` is `run.record.snapshot` (`repository.fullName` /
`localPath` give the cache key shared with the related-files route). The
section is not journaled (recovery never resends a prompt); the receipt goes
to the run log.

## Review fixes (same day)

- The identifier regex is bounded (64-character runs): long underscore or
  capital runs no longer backtrack quadratically (a crafted 512 KB file used
  to block the sidecar for minutes).
- Memory: one prepared index per repository (newest commit), at most three
  repositories; an index built with missing blobs (partial clone) is used
  but not written to the disk cache.
