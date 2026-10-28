# FE-14 / W20 — outbound webhooks

Date: 2026-10-27. Engineer id: `webhooks` (background agent).
Status: **implemented and locally validated; not committed, not deployed.**

## 1. Problem

FE-14 asks for "scheduled work, digests and webhook settings … durable jobs,
schedule history, replay protection and delivery status … retries do not
duplicate external delivery"; PRD W20 (operations) needs a way to tell other
systems what happened. Recurring issues shipped earlier (schedules.md); this
slice is **webhooks**: a project (or workspace) admin registers an HTTPS URL
and picks events; OpenLinear POSTs a signed JSON body per event, retries with
backoff, never turns one event into two different deliveries for the same
endpoint, and shows delivery history with "Redeliver".

Out of scope: digests (email/Slack summaries), receiver-specific formats
(Slack/Teams), inbound webhooks.

## 2. Model (migration `20261027265000_fe14_webhooks`)

| Table | Notes |
|---|---|
| `webhook_endpoints` | `scope` project \| workspace (CHECK: exactly one of `projectId` / `workspaceId`, FK cascade), `url` (≤ 2048, `^https?://`; full SSRF rules in the API), `description` ≤ 200, `eventTypes` 1–20, `secretEncrypted` (CHECK `enc:v1:%`: AES-256-GCM under `TOKEN_ENCRYPTION_KEY`, the GitHub-token envelope from `packages/db/src/crypto.ts`), `secretPrefix` (display), `previousSecretEncrypted` + `previousSecretExpiresAt` (rotation grace, both or neither), `active` ⇔ `disabledAt IS NULL`, `disabledReason` manual \| consecutive_failures \| owner_lost_access, `consecutiveFailures` ≥ 0, `lastSuccessAt`, `lastFailureAt`, `ownerId`, `createdById`. |
| `webhook_deliveries` | `endpointId` (FK cascade), `eventId`, **unique `(endpointId, eventId)`**, `eventType`, `payload` (the exact body, `octet_length` ≤ 64 KiB), `status` pending \| succeeded \| failed \| abandoned, `attempts`, `nextAttemptAt` (set exactly while pending), lease (`leaseToken` + `leaseExpiresAt`, both or neither), `lastAttemptAt`, `lastStatusCode` (100–599), `lastResponseExcerpt` ≤ 1024, `lastError` ≤ 500, `lastDurationMs`, `deliveredAt` (required when succeeded), `redeliveries`. Indexes `(endpointId, createdAt, id)` (history paging) and `(status, nextAttemptAt)` (claims). |
| `webhook_fanout_cursor` | Single row (CHECK id = 1): the last `domain_events.id` turned into deliveries. The migration starts it at the current stream head, so nothing from before webhooks existed is delivered. |

Additive only; indexes on new tables (opt-in comment like W17b/W20); drift
against the schema: 0.

## 3. Events and payloads

| Type | Source in the event stream |
|---|---|
| `issue.created` | `task:created`; `tasks:bulk-created` (one per issue, ≤ 200) |
| `issue.updated` | `task:updated` |
| `issue.done` | `activity:created` `task_status_changed` → done (a person); `agent_run_completed` succeeded (an agent: the run can only succeed after its done projection) |
| `issue.deleted` | `task:deleted` |
| `run.succeeded` / `run.failed` / `run.cancelled` | `activity:created` `agent_run_completed` by status |
| `plan.approved` | `plan:approved` |
| `schedule.fired` | `activity:created` `task_created` with `source: 'schedule'` |
| `ping` | "Send test ping" only (not subscribable) |

Body (exact bytes stored and re-sent on every attempt):

```json
{ "id": "<delivery id>", "type": "issue.done", "createdAt": "<event time>",
  "projectId": "…", "workspaceId": "…",
  "data": { "issue": { "id", "identifier", "number", "title", "status", "priority", "projectId",
                       "teamId", "parentId", "assigneeId", "labels": [{ "id", "name" }], "dueDate",
                       "prUrl", "archived", "createdAt", "updatedAt" },
            "from": "todo", "actorId": "…", "source": "person" } }
```

`run.*` adds `run: { id, agent, model, status, startedAt, endedAt, prUrl }`;
`schedule.fired` adds `schedule: { id, title, cadence }`; `plan.approved` is
`plan: { id, title, revision }`; `issue.deleted` is `issue: { id }`.
**Never included:** descriptions, outcomes, comments, execution logs, session
ids, error messages, tokens or anything from settings. A body over 64 KiB keeps
the envelope with `data: { truncated: true, issue: { id } }`.

## 4. Fan-out (exactly-once recording)

`webhook-deliver` job, step 1 (`services/webhook-events.ts`): one transaction
per batch of ≤ 500 stream events —

1. `SELECT … FROM webhook_fanout_cursor WHERE id = 1 FOR UPDATE SKIP LOCKED`
   (a second worker skips: `busy`);
2. read `domain_events` with `id > cursor` (stream ids become visible in commit
   order, W04b, so this is complete; events still in the outbox arrive later
   with higher ids);
3. keep events whose **resource binding** (not payload) names a project;
   match active endpoints of that project, or of its workspace; skip events
   older than the endpoint;
4. map to webhook events (loading the task/run/plan/schedule only when some
   matching endpoint wants that type; a loaded row from another project is
   dropped);
5. `createMany … skipDuplicates` on the unique `(endpointId, eventId)`, then
   advance the cursor — both commit together.

A replayed batch (cursor moved back, crash before commit) records nothing
twice (tested). Event ids: `evt_<stream id>:<type>[:<task id>]`.

**Tenancy and owner rights.** Each endpoint acts with its owner's current
rights (creator, then whoever last changed / re-enabled / rotated it — like
schedule owners). Before recording, the fan-out checks that the owner may
still manage it (project: full access + workspace owner/admin; workspace:
owner/admin). If not, the endpoint is turned off (`owner_lost_access`) and the
owner is notified. A workspace endpoint skips events of projects its owner is
denied.

Events only exist through the outbox, so no request handler calls into
webhooks; `OPENLINEAR_OUTBOX=0` (local-only events) means no webhooks.

## 5. Delivery, signatures, retries

Step 2 (`services/webhook-delivery.ts`): claim ≤ 50 due deliveries of active
endpoints with a 60 s lease in one `UPDATE … WHERE id IN (SELECT … FOR UPDATE
OF wd SKIP LOCKED)` (attempts incremented), POST 8 at a time, write each
result **fenced by the lease token** (a worker whose lease expired changes
nothing). Headers:

```
Content-Type: application/json
User-Agent: OpenLinear-Webhooks/1
OpenLinear-Delivery: <delivery id — the same on every retry and redelivery>
OpenLinear-Event: issue.done
OpenLinear-Timestamp: <unix seconds of this attempt>
OpenLinear-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>[,v1=<previous secret>]
```

- 2xx = delivered. Anything else (status, redirect, timeout, refused address,
  TLS/DNS error) = failed attempt; the status code, first 1 KB of the
  response (control characters stripped) and the error are kept.
- Retry schedule after attempt n: **1 m, 5 m, 30 m, 2 h, 12 h**; the sixth
  failure is final (`failed`).
- **20 failed attempts in a row** turn the endpoint off
  (`consecutive_failures`), abandon its pending deliveries and notify the
  owner. A success resets the count. Test pings never count.
- Crash after the POST and before the write: the lease expires and the same
  delivery is sent again with the same `OpenLinear-Delivery` — receivers
  dedupe on it. That is the only duplicate possible (at-least-once).
- No ordering guarantee between deliveries.

**Verifying (receivers).** Use the secret exactly as shown (`whsec_…`):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody: the request body as received (string), before JSON parsing.
export function verifyOpenLinear(rawBody, headers, secret, toleranceSeconds = 300) {
  const timestamp = Number(headers['openlinear-timestamp']);
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return String(headers['openlinear-signature'] ?? '').split(',').some((part) => {
    const [version, hex] = part.trim().split('=');
    if (version !== 'v1' || !hex) return false;
    const given = Buffer.from(hex, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
// Then: skip OpenLinear-Delivery ids already handled; answer 2xx quickly.
```

```python
import hashlib, hmac, time

def verify_openlinear(raw_body: bytes, headers, secret: str, tolerance=300) -> bool:
    ts = headers.get("OpenLinear-Timestamp", "")
    if not ts.isdigit() or abs(time.time() - int(ts)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(p.strip().startswith("v1=") and hmac.compare_digest(p.strip()[3:], expected)
               for p in headers.get("OpenLinear-Signature", "").split(","))
```

**Rotation.** "Rotate secret" returns a new secret once; the old one signs as a
second `v1=` for 24 h, then stops (tested).

**Job wiring** (`jobs/index.ts`, both runners, mutually exclusive as before):
interval mode runs a pass every **5 s** (a pass still running in the process
makes the next tick a no-op); pg-boss mode runs `webhook-deliver` every
**minute** (pg-boss cron granularity — first delivery can then take up to a
minute; retries are ≥ 1 minute apart anyway). `webhook-prune` (daily at 04:15;
also in the hourly interval maintenance) deletes finished deliveries older than
30 days and logs if the fan-out ever fell behind stream retention (48 h).
Test pings and redeliveries are attempted inline in the request, so they do
not wait for the job.

## 6. SSRF rules (`services/webhook-network.ts`)

- Registration: `https://` only; no user/password; no `#fragment`; no
  single-label hosts, `localhost`, `*.localhost|.local|.internal|.intranet|.lan|.home.arpa|.localdomain|.corp`;
  IP literals in a refused range rejected (decimal/hex IPv4 forms are
  normalized by the URL parser first: `https://2130706433/` is 127.0.0.1).
  400 `WEBHOOK_URL_INVALID` with `details.reason`.
- Every attempt resolves the host through `guardedLookup` (Node `dns.lookup`
  with `all: true`) and **refuses the attempt if any address is refused**; the
  socket connects to the checked address (no second resolution, so DNS
  rebinding between check and connect is impossible). IP-literal hosts are
  checked before connecting. A fresh agent per attempt (no pooled sockets).
- Refused IPv4: 0/8, 10/8, 100.64/10 (incl. 100.100.100.200), 127/8,
  169.254/16 (incl. 169.254.169.254), 172.16/12, 192.0.0/24, 192.0.2/24,
  192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4,
  240/4. IPv6: ::/96 (unspecified, ::1, IPv4-compatible), ::ffff:0:0:0/96,
  64:ff9b:1::/48, 100::/64, 2001::/23, 2001:db8::/32, fc00::/7 (fd00::/8,
  fd00:ec2::254), fe80::/10, fec0::/10, ff00::/8; plus the embedded IPv4 of
  IPv4-mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16`
  checked against the IPv4 list. Implemented with `net.BlockList`, no new
  dependency.
- Redirects are never followed (3xx = failure, `Location` noted); at most
  4 KB of the response is read, then the socket is dropped; 10 s budget for
  the whole exchange (also a receiver that trickles its body).
- Tests: `allowLoopbackWebhooksForTests(true)` permits plain `http://` to a
  loopback host only, throws outside `NODE_ENV=test`.

## 7. API

| Route | Auth / rights |
|---|---|
| `GET /api/projects/:id/webhooks` | view access (`projects:read`); `{ items, canManage, eventTypes, limits }`; full URL only for managers in a session (never a PAT), others get `urlDisplay` (origin + `/…`: paths often carry tokens) |
| `POST /api/projects/:id/webhooks` | **session only**; full access + workspace owner/admin (verification-settings rule); keyed (`webhooks.create`); 201 with `secret` once; ≤ 10 per project (advisory lock) |
| `GET|POST /api/workspaces/:id/webhooks` | any member reads (`workspaces:read`); owner/admin create, session only; ≤ 10 per workspace |
| `GET /api/webhooks/:webhookId` | read rights (workspace endpoints: a PAT also needs `workspaces:read`; `admin` for delete/ping/redeliver) |
| `PATCH /api/webhooks/:webhookId` | **session only** (the URL decides where signed events go); url, description, eventTypes, `active`; caller becomes owner; off → pending abandoned; on → failure count reset |
| `DELETE /api/webhooks/:webhookId` | manage (`projects:write`); history deleted with it |
| `POST /api/webhooks/:webhookId/rotate-secret` | **session only**; new secret once, old one signs 24 h |
| `POST /api/webhooks/:webhookId/ping` | manage (`projects:write`); one attempt, inline, also while off |
| `GET /api/webhooks/:webhookId/deliveries` | read; keyset `(createdAt, id)` newest first, `limit` ≤ 100, `status` filter, opaque `cursor` (400 when malformed) |
| `GET /api/webhooks/:webhookId/deliveries/:deliveryId` | read; + `payload`, `lastResponseExcerpt` |
| `POST /api/webhooks/:webhookId/deliveries/:deliveryId/redeliver` | manage; same delivery id and body, fresh schedule, attempted inline; 409 `WEBHOOK_DISABLED` while off (pings excepted), 409 `WEBHOOK_DELIVERY_IN_FLIGHT` while leased |

New registry resource params `webhook`, `webhookDelivery` (route inventory
probes foreign endpoints/deliveries; the "left in place" check covers them).
Errors: `WEBHOOK_URL_INVALID` (400), `WEBHOOK_LIMIT_EXCEEDED` (409, `{ limit,
scope }`), `WEBHOOK_NOT_FOUND`, `WEBHOOK_DELIVERY_NOT_FOUND` (404),
`WEBHOOK_DISABLED`, `WEBHOOK_DELIVERY_IN_FLIGHT` (409). Events (outbox,
project or workspace audience, ids only): `webhook:created|updated|deleted`.
Audit log (workspace): `webhook.created|updated|deleted|secret_rotated` with the
URL origin only.

**Idempotent create without a clear-text secret at rest.** The create command
stores its response with the secret only as ciphertext (`sealedSecret`); the
route decrypts it on the way out (first answer and replays). So a retry with
the same `Idempotency-Key` (same credential, 24 h) gets the same endpoint and
secret, and `idempotency_records` never holds the secret in clear (tested).
A replay after a rotation would show the pre-rotation secret.

## 8. Desktop (FE-14)

Project → Settings → **Webhooks** section (`components/webhooks/`, mounted in
`app/(app)/projects/manage/page.tsx` below Verification): endpoints with status
dot, URL (or origin for non-managers), events, secret prefix, last delivery,
failures in a row and why it is off; **On/Off** switch, **Test ping** (toast
with code and time), **Deliveries**, **Edit**, **Rotate secret** (confirm, new
secret shown once), **Delete** (confirm). The add form checks the URL locally
(https, no credentials), shows server refusals inline, and is keyed with an
`IdempotencyIntent`. The secret panel shows the value once with **Copy secret**
and how to verify. Deliveries table: event, status (Delivered / Retry at … /
Failed / Not sent / Sending…), response code, attempts n/6, last try,
**Redeliver**; expand for the exact body and last response; filters; "Load
older" (keyset); polls every 5 s while something is retrying. `lib/api/webhooks.ts`
holds the client, wording helpers and `webhookKeys`; error copy for the six
codes in `lib/api/errors.ts`.

## 9. Validation (local, 2026-10-27, DB `openlinear_webhooks_test`)

| Suite | Result |
|---|---|
| API full | **83 files, 962 passed + 3 skipped** (baseline before this slice: 81 files; the two webhook files add 104) |
| `webhook-network.test.ts` | 80 (pure): refused IPv4/IPv6 incl. mapped/NAT64/6to4/metadata, URL rules incl. decimal/hex IPv4, test hook only under NODE_ENV=test, guarded lookup (mixed answers refused, resolver errors, loopback only under the hook), IP-literal checks |
| `webhooks.test.ts` | 24 against a 127.0.0.1 receiver: create (secret once, ciphertext in DB and idempotency record, keyed replay returns the same secret, audit origin only), viewer/member/stranger/PAT rights, refused URLs, quota, workspace endpoints, PATCH off/on/owner, delete + project cascade; fan-out e2e (create + done → 3 signed deliveries; body shape; no description; signature verifies; replayed cursor records nothing), tenancy (project, sibling, workspace, other workspace, unsubscribed type, endpoint created later, denied project), owner lost access → off + notified, retry schedule through `failed` + redelivery with the same id, 20 failures → off + abandoned + notified + ping still works, 3 racing workers → 6 deliveries sent once each, job pass + overlap guard, prune; timeout / 4 KB cap / redirect not followed; refused addresses without connecting; ping; rotation grace and expiry; history paging; event mapping (runs, issue.done from agents, schedule.fired, plan.approved, deleted, bulk, foreign project ignored, DTO projection) |
| route inventory, authorization matrix, PAT policy, pg-boss wiring | pass (webhook fixtures and queues added) |
| desktop-ui full | **98 files, 1239 passed + 9 skipped**; `components/webhooks/webhooks.test.mjs` (9), `errors.test.mjs` (+1, six codes required), settings/team page tests |
| typecheck | api, desktop-ui: 0 |
| biome | new API files + edited `registry.ts`, `jobs/`, inventory and pg-boss tests: clean; new desktop files: clean |
| migration / drift | `prisma migrate deploy` on a fresh DB; `prisma migrate diff --from-config-datasource --to-schema` → no difference |

## 10. Limits and open items

- pg-boss mode delivers within a minute (cron granularity); interval mode
  within ~5 s. A self-rescheduling pg-boss job (`send` with `startAfter`)
  would bring pg-boss down to seconds.
- No per-endpoint concurrency cap or ordering: a slow receiver can take up to
  8 parallel requests per pass.
- Workspace endpoints have API + tests but no desktop screen yet (workspace
  settings).
- The owner notification reuses the `status_change` type (no new enum value,
  so the inbox renders it); a dedicated type is a follow-up.
- Deliveries are recorded for active endpoints only: events that happen while
  an endpoint is off are never sent (redeliver handles what was abandoned).
- If the fan-out falls more than 48 h behind (stream retention), events are
  missed; the prune job logs it.
- Not in project export (secrets must not be exported; endpoints without
  secrets could be added).
- Deploy order when shipped: migration → API (job starts with it). Needs
  `TOKEN_ENCRYPTION_KEY` (already required for GitHub tokens).

## 11. Follow-up: Slack / Discord formats, daily digest, workspace screen, export

Date: 2026-10-27. Engineer id: `webhook-integrations` (background agent).
Status: **implemented and locally validated; not committed, not deployed.**
This closes the §1 "out of scope" items digests and receiver formats (Slack,
Discord; Teams is still out) and the §10 limits "no workspace screen" and
"not in project export".

### 11.1 Model (migration `20261027280000_fe14_webhook_formats_digests`)

Additive, on `webhook_endpoints` only (new in the previous, not yet deployed
migration): `format` TEXT NOT NULL DEFAULT `'openlinear'` (CHECK `openlinear |
slack | discord`), `digestHour` INT (0–23) and `digestTimezone` TEXT (1–64
chars), both or neither, and `digestNextAt` TIMESTAMP(3) (only with an
hour). Existing endpoints keep the old behaviour (`openlinear`). No index:
the digest sweep reads `webhook_endpoints` (≤ 10 per project or workspace).
Drift against the schema: 0.

### 11.2 Body formats (`services/webhook-formats.ts`)

| `format` | Body | URLs it accepts |
|---|---|---|
| `openlinear` (default) | the signed JSON envelope of §3, unchanged | any URL that passes §6 |
| `slack` | Slack incoming-webhook message `{ text, blocks }` | `https://hooks.slack.com/services/…` (default port) |
| `discord` | Discord webhook message `{ content, embeds, allowed_mentions: { parse: [] } }` | `https://discord.com/api/webhooks/…`, `https://discordapp.com/api/webhooks/…` |

- Checked on create and on every change of URL or format: 400
  `WEBHOOK_URL_INVALID` with `details.reason` `slack_url_required` /
  `discord_url_required` and `details.format`. The SSRF rules (§6) run first
  and still apply to every attempt. Tests deliver every format to a 127.0.0.1
  receiver through the existing loopback test hook (NODE_ENV=test only).
- Same delivery path for every format: delivery ids, the unique (endpoint,
  event) key, leases, retries, history, redeliver, test pings (rendered in the
  format: "Test message from OpenLinear · <project>"). The `OpenLinear-*`
  headers, signature included, are still sent; Slack and Discord ignore them.
- The body is rendered when the delivery is recorded and stored as before, so
  redeliveries resend exactly what was sent; changing the format affects new
  deliveries only.
- What a message says: a heading ("Issue created", "Agent run failed", "Plan
  approved", "Daily digest · 2026-10-27", …), the subject (issue identifier +
  title, plan title, or project), a few enum details (status, priority, runner
  and model, plan revision, schedule title), a link back ("Open in
  OpenLinear": `FRONTEND_URL` + `/?task=<id>`, `/projects/plans?id=…&plan=…`,
  `/projects/board?id=…`) and, for runs, the pull request (http(s) URLs only).
  Never descriptions, outcomes, comments, logs, error messages or secrets —
  the same facts as the JSON body, and titles additionally go through the
  export redaction (`redactText`: a token pasted into a title stays out of a
  chat channel), lose control characters and are clipped to 200 characters.
- Escaping: Slack gets `& < >` as entities, so a title cannot form
  `<!channel>`, `<@U…>` or `<url|label>` (plain `@channel` does not notify
  without `link_names`). Discord gets a backslash before every Markdown
  character (`* _ ~ \` | > < # - [ ] ( ) @ : !`), so a title cannot format,
  quote, link or mention, and `allowed_mentions.parse = []` makes sure nothing
  pings. Text is clipped before escaping, so Discord's limits (title 256,
  content 2000, description 4096, 25 fields) hold without a dangling escape.

Slack example (issue created):

```json
{ "text": "Issue created: ENG-12 Fix login · Web app",
  "blocks": [
    { "type": "section", "text": { "type": "mrkdwn", "text": "*Issue created*\nENG-12 Fix login\nStatus: Todo\nPriority: high\n<https://app.example/?task=…|Open in OpenLinear>" } },
    { "type": "context", "elements": [{ "type": "mrkdwn", "text": "Web app · OpenLinear" }] } ] }
```

### 11.3 Daily digest (`digest.daily`, `services/webhook-digest.ts`)

- Subscribed like any other event type, with `digestHour` (default 9) and
  `digestTimezone` (IANA, canonicalized, default UTC; the desktop sends the
  device's zone). Unknown zones: 400 `VALIDATION_ERROR`, `details.field =
  digestTimezone`.
- **Timing.** The slot math of recurring issues (`schedule-slots.ts`, daily at
  `hour:00`): on a daylight-saving day a missing hour fires after the jump,
  a repeated one fires once. `digestNextAt` is the next slot; it is set while
  the endpoint is on and subscribed, kept by edits that do not touch the
  schedule (a new description does not move today's digest), recomputed when
  the hour or zone change and when the endpoint is turned back on (no stale
  digest right after), and cleared when it is turned off or unsubscribed.
- The sweep runs inside every `webhook-deliver` pass (fan-out → digests →
  deliveries), so a digest is recorded and sent within ~5 s of its hour with
  the interval runner and within a minute with pg-boss. No new job or queue.
- **Window and numbers.** `[previous day's slot, slot)` — 23, 24 or 25 hours.
  One SQL statement (CTEs grouped by project), definitions as in insights:
  issues created (in the window); completed (done now, last recorded move to
  done in the window — status change or an execution attempt ending as done);
  blocked now (open, unarchived, with a blocker that is not done); agent runs
  succeeded / failed (by `endedAt` in the window); plans awaiting review now;
  knowledge proposals waiting now (`knowledge_entries.status = 'proposed'`).
- Workspace endpoints summarize the workspace's projects minus those that
  explicitly deny the endpoint's owner (what a workspace member reads, as in
  workspace insights; at most 500 projects read): totals, `projectCount`, and
  `projects` (the 20 most active with any activity).
- Body (`openlinear`):

```json
{ "id": "<delivery id>", "type": "digest.daily", "createdAt": "<slot>", "projectId": "…", "workspaceId": "…",
  "data": { "digest": { "date": "2026-10-27", "timezone": "Europe/Berlin", "hour": 9, "since": "…", "until": "…",
                        "issues": { "created": 3, "completed": 2, "blocked": 1 }, "runs": { "succeeded": 4, "failed": 1 },
                        "plansAwaitingReview": 1, "knowledgeProposals": 2 },
            "project": { "id": "…", "key": "WEB", "name": "Web app" } } }
```

  (workspace: `projectId: null`, `data.workspace { id, name }`,
  `data.projects[]`, `data.digest.projectCount`). Slack / Discord get "Daily
  digest for Web app, 2026-10-27: 3 issues created, 2 completed, 1 blocked; 4
  runs succeeded, 1 failed; 1 plan and 2 knowledge proposals waiting for
  review" plus the numbers as fields and links to plans / knowledge waiting.
- **Idempotency: one digest per (endpoint, local date).** Decision: a
  deterministic event id on the existing unique `(endpointId, eventId)` key —
  `digest.daily:<YYYY-MM-DD>`, the slot's local date — rather than a new
  table: the delivery row already is the per-day record (history, retries,
  redeliver, prune) and the key is an existing unique index. Each due endpoint
  is handled in one transaction: `SELECT … FOR UPDATE SKIP LOCKED` on its row,
  re-read (still on, same owner, still due), the owner's rights (lost → off
  and notified, as in the fan-out), the numbers, `INSERT … ON CONFLICT DO
  NOTHING`, then `digestNextAt` moves to the next slot — one commit. So a
  second worker skips the locked row and then finds it no longer due; a crash
  before the commit redoes everything; a re-run after it (a due time moved
  back, or a new hour or zone on a day that already had its digest) hits the
  key and records nothing (`duplicate`). A due time off the hour grid (never
  written by the code) just moves on to the next slot.
- After downtime only the latest due slot gets a digest; missed days are not
  replayed (like recurring issues).

### 11.4 Desktop

- **Settings → Webhooks** (new nav item): the workspace's webhooks
  (`components/webhooks/workspace-webhooks-settings.tsx`), starting on the
  active workspace with a picker for people in several. It reuses the project
  components: `webhooks-section.tsx` is now a scope-aware panel
  (`WebhooksSection` for a project, `WorkspaceWebhooksSection` for a
  workspace); `lib/api/webhooks.ts` gained the workspace list/create calls and
  `webhookKeys.workspaceList` / `forScope`.
- The add/edit form has **Send as** (OpenLinear JSON / Slack / Discord, with a
  per-format URL placeholder and local URL check) and, when **Daily digest**
  is ticked, **Send at** (00:00–23:00) and **Time zone** (the runtime's IANA
  zones, the device's by default). Rows show a Slack / Discord badge and
  "Daily digest at 09:00 (Europe/Berlin) · next Oct 28, 09:00". The secret
  panel says Slack / Discord ignore signatures. Error copy for the two new
  reasons in `lib/api/errors.ts`.

### 11.5 Project export (`services/project-export.ts`)

`webhooks[]`: the project's endpoints (not workspace ones) with `origin`
(scheme, host, port — never path or query, which often carry receiver
tokens), description (redacted), `eventTypes`, `format`, digest hour and zone,
`active`, `disabledAt` / `disabledReason`, `consecutiveFailures`,
`lastSuccessAt` / `lastFailureAt`, and `recentDeliveries` — the last 20,
newest first: `{ id, eventType, status, attempts, lastStatusCode,
lastAttemptAt, deliveredAt, redeliveries, createdAt }`. Never the secret (nor
the previous one or its prefix), bodies, response excerpts or error text;
`omitted` says so.

### 11.6 Fix: the delivery claim could exceed its limit

Found while validating. `UPDATE … WHERE id IN (SELECT … LIMIT n FOR UPDATE
SKIP LOCKED)`: with the statistics of a small or new table PostgreSQL picks a
nested-loop semi join that re-runs the subquery for every outer row; each
re-run skips the rows the statement already updated and returns the next
ones, so `LIMIT 1` leased every due row (reproduced in psql: 3 of 3; the
regression test: 4 of 4). In production a pass could claim far more than 50,
and leases (60 s) could run out while rows waited in the 8-wide queue —
another worker would then send them again. Now `WITH due AS MATERIALIZED (…)
UPDATE … FROM due` (evaluated once). The regression test forces that plan
(`ANALYZE` of the emptied table) and fails on the old statement. It also
explains a flaky full-suite failure of §9's "20 failures in a row" test (21
counted: the `limit: 1` pass attempted both deliveries).

### 11.7 Validation (local, DB `openlinear_digest_test`)

| Suite | Result |
|---|---|
| API full | **85 files, 984 passed + 3 skipped** (before this slice: 83 files, 962 + 3; other agents' suites included) |
| `webhook-formats.test.ts` (new, pure) | 10: URL rules per format (lookalike hosts, ports, paths, http, loopback hook only under the test flag), Slack body (escaped, redacted, link back, no description), every event's wording and links (no `javascript:` PR links), Discord body (`allowed_mentions`, escaped title, limits with 5 000-char titles), digest messages (project, workspace with project list), DST windows (Berlin fall-back: 25 h; New York spring-forward: 02:00 fires at 03:00), digest settings (defaults, kept / recomputed due time, off, unsubscribed, zone canonicalization) |
| `webhooks.integrations.test.ts` (new, 127.0.0.1 receiver) | 8: format URL rules on create and PATCH (SSRF first, audit), digest settings over the API (defaults, zone, invalid zone / hour, off/on, edits keep the due time, unsubscribe), Slack + Discord deliveries signed and titles-only (+ ping in format), claim limit regression, digest numbers end to end (seeded window incl. outside-window rows) + signed delivery + re-run = duplicate + next day, 3 racing sweeps → one digest, Slack digest text + workspace digest (denied project excluded) through `runWebhookCycle`, owner lost access → off + notified |
| `project-export.test.ts` | + webhooks: origin only, redacted description, format / digest, 20 newest deliveries without bodies, no secret / path / query / response / error text |
| `webhooks.test.ts`, `webhook-network.test.ts` | unchanged, pass (the flaky "20 failures" case fixed by §11.6) |
| desktop-ui full | **98 files, 1243 passed + 9 skipped**; `components/webhooks/webhooks.test.mjs` 13 (+4: Slack + digest form, row badge and digest time, workspace section, Settings → Webhooks picker), `errors.test.mjs` (+2 assertions) |
| typecheck | api, desktop-ui: 0 |
| biome `--error-on-warnings` | all new / changed API files and the desktop webhook files: clean |
| migration | `prisma migrate deploy` on the DB; `migrate diff --from-config-datasource --to-schema --exit-code` → 0, no difference; `scripts/ci/migration-safety.sh --files` → checked (no destructive DDL, no index) |

### 11.8 Limits

- The workspace screen does not refresh on `webhook:*` SSE events of
  workspace endpoints (the bridge invalidates project lists and the endpoint
  key only); it refreshes after its own changes. Needs a workspace key in
  `lib/query/keys.ts` and one line in `lib/query/sse-bridge.ts`.
- Digests are sent on quiet days too (all zeros); no "skip empty days" option.
- Slack (about 1 message per second per webhook) and Discord (about 30 per
  minute per channel) rate limits are not paced: a burst (100 bulk-created
  issues) gets 429s and goes through the normal retry schedule.
- Links point at `FRONTEND_URL` (the web app); a deployment must set it to the
  URL people open. No desktop deep links.
- No Microsoft Teams format.
- Digest numbers follow an issue's current project (as insights); runs count
  by when they ended.
- New lint-list entries (root `package.json`) for the new API files are left
  to the coordinator.

## 12. Security review fixes (2026-10-27)

- **Hostile titles (high):** a very long title (`a.a.a…`) made the
  credential-in-URL redaction backtrack quadratically inside the fan-out
  transaction, freezing the API and stalling every tenant's webhooks. Now:
  titles are clipped before redaction in chat messages, the URL-scheme
  pattern in `lib/redact-text.ts` is bounded, task titles are capped at 500
  characters on create/update, and the fan-out survives a failing batch
  (halves the batch, and skips — with an error log — a single event that
  keeps failing while the database answers).
- **Workspace endpoints vs project deny (medium):** people explicitly denied
  any project in the workspace can no longer list/read deliveries of, change
  or redeliver a workspace webhook (`WEBHOOK_WORKSPACE_RESTRICTED`).
- **Lease (medium):** the lease covers a whole claimed batch at full
  timeouts (130 s) and is renewed, fenced by its token, right before each
  POST; a lost lease or an endpoint turned off meanwhile sends nothing (the
  attempt is handed back).
- **Lows:** refused-address errors no longer include the resolved IP; a
  second rotation inside the 24 h grace period is refused
  (`WEBHOOK_ROTATION_IN_PROGRESS`); Azure's platform address 168.63.129.16
  and `3fff::/20` are refused; only ports 443/8443; webhook DNS uses a
  resolver with a 3 s timeout instead of `dns.lookup` on libuv's pool.
- **PAT scope family and URL exposure (low, fixed in a follow-up):** a
  workspace endpoint is workspace configuration, so on `/api/webhooks/:id…`
  a PAT now also needs `workspaces:read` to read it or its deliveries and
  `admin` to delete, ping or redeliver (403 `INSUFFICIENT_SCOPE` with
  `requiredScopes`; the route declarations still check `projects:*` first).
  The full `url` (a Slack/Discord URL is a credential) now goes only to a
  session that may manage the endpoint, like the secret; PATs — read or
  write — get `url: null` and `urlDisplay`, with `canManage` unchanged.
  Test: "workspace endpoints need the workspace PAT family…" in
  `webhooks.test.ts`.
