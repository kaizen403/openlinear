# W20 — operations CLI (`openlinear`)

Date: 2026-10-27. Status: **implemented and tested against a recorded fake
`fetch`; not published.** Package `packages/openlinear-cli` (CommonJS,
Node ≥ 18, no new dependencies: built-in `fetch` and `util.parseArgs`).

The launcher kept its behaviour (`openlinear install`, anything else starts
the desktop app); these subcommands are handled first:

| Command | Calls | Does |
|---|---|---|
| `issues --project <id> [--status s] [--limit n]` | API `GET /api/tasks` | identifier, status, title |
| `issue <id\|ENG-12>` | API `GET /api/tasks/:id` | status, priority, blockers, plan, description |
| `status <task>` | sidecar `GET /api/tasks/:id/run` | state, runner, outcome, verification, time per phase |
| `logs <task>` | sidecar `GET /api/tasks/:id/logs` | the run log |
| `run <task> [--allow-blocked]` | sidecar `POST /api/tasks/:id/execute` | start the agent |
| `cancel <task>` | sidecar `POST /api/tasks/:id/cancel` | stop it |
| `continue <task> [-m text]` | sidecar `POST /api/tasks/:id/follow-up` | follow-up (default: continue an interrupted run) |
| `export <projectId> [-o file] [--force]` | API `GET /api/projects/:id/export` | project export (file written 0600; existing file only with `--force`) |
| `insights <projectId> [--range 7d\|30d\|90d]` | API insights | rates, run time, cost (unknown counted), delivery |
| `knowledge <projectId>` | API knowledge | what every run in the project is given |
| `remember <projectId> --title --body [--kind]` | API `POST …/knowledge` (keyed) | a proposal a person approves |
| `whoami` | API `GET /api/users/me` | the account |

- **Auth:** `OPENLINEAR_TOKEN` (a personal access token) in the
  Authorization header only; never printed or put in a URL. A PAT can only
  *propose* knowledge (W19b).
- **Where:** `OPENLINEAR_API_URL` (default `https://api.openlinear.tech`) and
  `OPENLINEAR_SIDECAR_URL` (default `http://127.0.0.1:3003`, the local app);
  an unreachable sidecar says "is the OpenLinear app running?".
- **Tasks** by UUID or identifier (`ENG-12`, exact case-insensitive match via
  `GET /api/tasks?q=&identifier=`, all pages up to 5 × 100; ambiguous across
  workspaces or not exhausted → refused). Project ids must be UUIDs.
- **Output:** human text, or `--json` with the API's own body. Exit codes: 0
  ok, 1 request failed (`CODE: message` on stderr), 2 usage, 3 no / refused
  token.

Not included: device/session revocation and PAT management (the API only
allows them from an interactive session — use the app), retry/salvage
beyond `continue` (a new run is `run`).

Tests (`node --test`): command routing vs the app launcher; API vs sidecar
targets and bodies; token only in the header; identifier resolution (exact,
not `ENG-120`; none; ambiguous); status with phases; run/cancel/continue
bodies; export to file; `--json`; remember with an idempotency key;
insights summary; exit codes for usage, missing/refused token, API refusal
and an unreachable sidecar; plus the security fixes below. 29 ops tests,
38 with the installer's.

## Security review fixes (2026-10-27)

All reproduced by a reviewer; each has a regression test in
`packages/openlinear-cli/test/ops.test.js`.

| # | Sev | Finding | Fix |
|---|---|---|---|
| 1 | High | Titles, descriptions, statuses, identifiers, logs, knowledge text and server error codes/messages reached the terminal raw (escape-sequence injection) | `safe()` (multi-line: keeps `\n`/`\t`) and `safeLine()` (one-line fields: also `\n`/`\r`/`\t`) show C0, DEL, C1 and bidi controls (U+061C, U+200E/F, U+202A–202E, U+2066–2069) as `\uXXXX`; applied per field, again to the whole human output, and to everything on stderr including echoed user input. `--json` stays JSON (DEL/C1/bidi written as `\u` escapes; parses to the same value) |
| 2 | Medium | A token with `\n`/`\r`/`\0` made fetch throw a message containing the token, which was printed | Token must match `^[\x21-\x7e]+$` before any request (`INVALID_TOKEN`, exit 3, not echoed); fetch failures are reported as `cause.code ?? name`, never the message; stderr also redacts the token |
| 3 | Medium | Token sent over plain http to any host; credentials in URLs; redirects followed | `https:` required unless loopback (`localhost`, 127.0.0.0/8, `[::1]`); user info, query or fragment refused (exit 2, value not echoed); `redirect: 'error'`. Known limit: the default sidecar URL is loopback http and the token goes to whatever listens there (discovery file = future work) |
| 4 | Medium | `ENG-12` lookup read only the first 100 `q=` results | New API filter `GET /api/tasks?identifier=` (exact, case-insensitive, AND with visibility). CLI sends `q`+`identifier`, `view=compact`, cursor pages (≤ 5), keeps the client-side exact filter for older APIs, refuses `IDENTIFIER_LOOKUP_INCOMPLETE` when not exhausted, and refuses a non-UUID id in the answer |
| 5 | Medium | Export: 0600 only on create, followed symlinks, silent overwrite | Temp file in the target directory (`wx`, 0600, fchmod), then `link()` (atomic no-clobber) or, with `--force`, `rename()` (replaces a symlink, never writes through it); temp removed on failure; existing target refused before the download |
| 6 | Low | Non-JSON or empty 2xx treated as success | `BAD_RESPONSE`, exit 1 (204 excepted) |
| 7 | Low | Cancel printed "Cancelled." while the sidecar answered 202 (still stopping) | 202 → `Cancelling… (still in progress)`; "Cancelled." only for 200 |
| 8 | Low | `.` / `..` project ids reached other routes | Project ids (`export`, `insights`, `knowledge`, `remember`, `--project`) must be UUIDs |
| 9 | Low | No timeout or size cap | `AbortSignal.timeout` 60 s (export 300 s); body read incrementally and abandoned past 32 MiB (export 512 MiB): `TIMEOUT` / `RESPONSE_TOO_LARGE`, exit 1 |
| 10 | Low | Extra arguments silently ignored | Per-command option sets (`--json`/`--help` everywhere), extra positionals and empty option values refused; `openlinear --json whoami` works |
| 11 | Low | `remember` used a random idempotency key, so a retry after a timeout could propose twice | Key is `cli-` + sha256(project, kind, title, body) |

API: `listTasksQuerySchema.identifier`
(`/^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/`, no LIKE metacharacters), one more
conjunct in `buildTaskListWhere`; test in `tasks.list.test.ts` (exact only,
not `-120`, case-insensitive, denied project and other tenant excluded,
malformed → 400).
