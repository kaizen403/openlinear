# Home Chat client for the safety and metering backend (`chatui`)

Date: 2026-10-26 (work done 2026-10-25). Engineer id: `chatui`. Base: `922dbd7` + `round2c-base.patch` (base tree `7c86a11f`). Frontend only: no API, schema or migration changes. Not committed, not deployed, no provider calls.

The desktop UI now handles the backend from `ai.md`:
- **Confirmation cards:** `confirmation_required` is shown as a card with Confirm and Dismiss, sent through `confirmationTokens`.
- **Tool rows:** each tool call shows its effect class and its status, including "outcome unknown".
- **Usage:** each reply shows its usage, the chat shows a running total, and a compact usage view reads `GET /api/usage/models`.
- **Errors:** chat errors map to actionable copy. A failed or truncated reply keeps its partial text, marked incomplete, with a Retry action.

## 1. What changed

| Area | Change | Files |
|---|---|---|
| Stream contract | `ChatChunk` gains `confirmation_required` (`code`, `expiresAt`, `summary`), `finishReason`, `effect` (forward-compatible) and the full `done.usage` shape (`ChatTurnUsage`: tokens, cache, reasoning, `costUsd: number \| null`, `costBasis`, `coverage`). `ChatToolResult` accepts the flat server shape `{ ok, code, message, data?, details? }`. `sendChatMessage(…, confirmationTokens?)` sends the field only when it is non-empty. Errors are now `ChatStreamError extends ApiError`, carrying `code`, `details`, the HTTP status and `origin` (the original request error). A stream that ends without `done` or `error` now ends in `CHAT_STREAM_INTERRUPTED` instead of `onDone`. CRLF framing and `data:` with no space are parsed. | `lib/api/chat.ts` |
| Tool effects | `CHAT_TOOL_EFFECTS` mirrors the server's 34-tool classification (14 read, 13 write, 7 destructive; a test pins these counts). The SSE stream does not send the effect yet (see §4). | `lib/api/chat.ts` |
| Usage API | `fetchModelUsage({ days, workspaceId, surface })` calls `GET /api/usage/models` (cloud). A `CASES` row was added to the route test. | `lib/api/chat.ts`, `lib/api/routes.test.mjs` |
| Error copy | 41 additive `API_ERROR_COPY` entries: provider and turn errors (`LLM_*`, `TURN_TIMEOUT`, `ROUND_LIMIT`, `CHAT_*`, `SESSION_NOT_FOUND`, …), confirmation and tool codes (`CONFIRMATION_*`, `TOOL_OUTCOME_UNKNOWN`, `SELECTION_TOO_LARGE`, …), and the client code `CHAT_STREAM_INTERRUPTED`. Transient provider failures are `retryable`. `LLM_RATE_LIMITED` reads `retryAfterSeconds`. Raw provider text is never shown. | `lib/api/errors.ts` (additive) |
| Stream state (pure) | New module, unit-tested on its own. It covers: tool-call construction (effect, plus `redeems` read from `args.confirmationToken`); result interpretation (`needs_confirmation` / `unknown` / `error` / `completed` with mapped copy); preview parsing (status change, archive, generic arguments); the confirmation lifecycle (`pending → submitting → confirmed / rejected / outcome_unknown / superseded / unresolved / dismissed`); interrupted calls; history replay; and session usage totals. | `hooks/chat-stream-state.ts` |
| Hook | `useChatStream` keeps its public API (`messages`, `status`, `streamingContent`, `activeToolCalls`, `send`, `stop`, `reset`, `loadHistory`) and adds `confirm(code)`, `dismissConfirmation(code)`, `retry(messageId)`, `confirmations`, `sessionUsage` and `controls`. `controls` is the single object the transcript needs. `send` takes an optional fourth argument, `{ confirmationTokens }`. `loadHistory(history, sessionId?)` now joins stored `tool` rows to their calls and rebuilds the confirmation cards. | `hooks/use-chat-stream.tsx` |
| Confirmation card | Shows exactly what will change. Header: "Set status to done on N issues" or "Archive N issues". Then: the issue list (identifier, title, current status → new status); "N already have this status"; a "Not found" line; a whole-project warning; and exact arguments for generic confirmations. Buttons: Confirm and Dismiss, plus the expiry time with a live countdown and the code for the typed fallback. Each terminal state has its own text, and a polite live region announces state changes. | `components/chat/confirmation-card.tsx` |
| Tool rows | Each row shows an effect badge (Read / Write / Destructive / External) and a status label (Queued / Running / Done / Failed / Outcome unknown / Needs confirmation). An unknown outcome is always shown, outside the collapsible. The toggle uses `aria-expanded`. The confirmation card renders under its row. | `components/chat/tool-call-card.tsx` |
| Turn rendering | An incomplete reply keeps its partial text inside a dashed border with an "Incomplete" or "Cut off" label. An error callout (`role="alert"`) shows the mapped message, a hint and Retry. If a write already ran, it warns "Some actions in this reply already ran". A collapsed `<details>` usage footer sits under the reply. | `components/chat/chat-message.tsx`, `components/chat/turn-usage.tsx` |
| Usage view | A header button shows the chat's running total. Its popover holds the session breakdown plus "Your model usage, last 30 days": calls, unreported calls, input and output tokens, cache reads with hit rate, cost coverage, and the top 5 model groups. | `components/chat/chat-usage-view.tsx`, `components/chat/usage-format.ts` |
| Transcript | `controls` is passed down to every message. A polite `role="status"` line announces thinking, responding, "Running X", finished, failed or stopped — not every token. `aria-busy` is set while streaming. Keys are stable message ids. Spinners and the pulse use `motion-reduce:animate-none`. | `components/chat/chat-message-list.tsx` |
| Wiring | Chat panel: usage button in the header, `controls` passed to the list, `loadHistory(messages, sessionId)`, and the rename pencil now shows on keyboard focus. Sidebar drawer: passes `controls` (2 lines). | `components/chat/chat-panel.tsx`, `components/brainstorm/brainstorm-drawer.tsx` |

`BulkPreviewCard` is unchanged. It is a client-side "create these issues" editor that nothing renders today, and it is unrelated to the server's confirmation flow.

## 2. UX decisions

- **Confirm button vs typed code.**
  - The button is the main path. It sends `confirmationTokens: [code]`, containing exactly that card's code, with the visible message `Confirm CONFIRM-XXXXXXXX: <summary>`.
  - The code is also in the text because the system prompt tells the model to redeem a code only when "the user's own latest message contains it". The server merges the text and the field, so nothing is counted twice.
  - The typed fallback is unchanged: replying with the code (any case) still works. The matching card moves to "Confirming…" and then shows the outcome.
- **No auto-confirm and no double submit.**
  - Only a user click or a user-typed code submits a code.
  - Three guards stop a second submit: a synchronous lock in the hook (two clicks in one tick send once), a card-level click guard, and the rule that only a `pending` card that has not expired can be confirmed.
  - Confirm is disabled while a reply is streaming (the server needs a new user turn anyway).
- **Refusals only close cards the user submitted.** If the model replays a code on its own, the server answers `CONFIRMATION_NOT_FROM_USER` and the card stays usable. Any successful redemption marks the card confirmed.
- **Stale, used, expired or mismatched codes** get the server's code and the mapped copy, for example "The issues changed after this preview was made. Nothing changed. Ask the assistant for a fresh preview, then confirm that one." The card is then closed for good.
- **Expiry** is computed from `expiresAt` with a 1 s countdown. An expired card loses its Confirm button and says "Expired at HH:MM. Nothing changed; ask the assistant for a fresh preview."
- **A confirmation the server never acknowledged** (request failed before `user_message`, for example a 429) reopens the card with the reason. Resending is safe because codes are single-use on the server.
- **A newer preview in the confirming turn** marks the old card "Replaced by a newer preview".
- **Dismiss** only closes the card on this client; nothing is sent to the server (see §4).
- **Retry** resends the original request exactly: text, attachments and tokens. This is safe because codes are single-use; the card shows whatever the server answers. A used Retry turns into "Retried below."
  - Stopped replies also get Retry.
  - Replies cut off at the length limit are marked but get no Retry, because a retry would give the same result.
- **Interrupted calls.**
  - A call still running when a turn fails or is stopped is shown as "Outcome unknown" if it is a write, a redeeming destructive call, or an unclassified tool.
  - It is shown as "Failed: Interrupted… Nothing was changed" if it is a read or a preview, which cannot have changed anything.
  - A stored write call with no stored result (a turn that crashed) loads the same way.
- **Usage.**
  - Each reply shows "1.3k tokens · 1.0k cached · cost unknown". It expands to input (with cache reads), output (with reasoning), model calls with partial coverage, and the cost basis.
  - An unknown cost is always shown as "cost unknown", never $0. Estimates are marked "≈". A tiny known cost shows as "< $0.0001", not $0.00.
  - The session total is marked "≥" when any reply lacked usage or cost.

## 3. Contract used (verified against `apps/api/src/services/chat.ts`, `chat-tools/{index,confirmations,domain,types}.ts`, `routes/{chat,usage}.ts`)

- **Request body:** `POST /api/chat/sessions/:id/messages` with `{ content, attachmentIds?, confirmationTokens? }`. Each token must match `^CONFIRM-[0-9A-HJKMNP-TV-Z]{8}$`, case-insensitive, at most 5.
- **Preview call:**
  - The preview is `tool_result.result = { ok: false, code: 'CONFIRMATION_REQUIRED', message, details: { confirmation: { id, code, expiresAt }, summary, preview } }`. The `preview` is `{ status, selection, willChange[], alreadyInStatus, notFound[] }` for a status change or `{ willArchive[], notFound[] }` for an archive.
  - It is followed by `confirmation_required { toolCallId, toolName, code, expiresAt, summary }`.
- **Redeeming call:** `tool_call_start.args.confirmationToken`. Success: `details.confirmationId`. Failure codes: `CONFIRMATION_{EXPIRED,USED,STALE,INVALID,NOT_FROM_USER,REQUIRES_USER_TURN}`.
- **Outcome unknown:** `TOOL_OUTCOME_UNKNOWN` (`details.cause`).
- **Usage:** `done.usage` is the server's `TurnUsageSummary`. `GET /api/usage/models?days=&workspaceId=&surface=` returns `{ since, days, workspaceId, surface, totals, groups[] }`.
- **Errors:** an `error { code, message, details? }` chunk ends the turn; the server already saves the partial assistant text.

## 4. Contract gaps (recorded, not changed: apps/api is not mine)

1. **Tool effect is not on the stream.** `tool_call_start` and `tool_result` do not carry `effect`, so the client keeps a mirror (`CHAT_TOOL_EFFECTS`) that can drift. Suggested fix, 2 additive lines in `services/chat.ts`: `effect: getToolEffect(call.function.name)`. The client already prefers a server-sent `effect`.
2. **Reconciled outcomes are invisible.** `reconcileLateOutcome` writes the real outcome to `chat_tool_calls` only. Nothing exposes it (no route, no SSE event, not in `GET /sessions/:id`), so an "Outcome unknown" row stays unknown, even after a reload. Needs a `tool_reconciled` event, or the journal status on history rows.
3. **Saved partial answers look complete.** Partial text saved on error is stored as a normal assistant message. After a reload it cannot be told apart from a complete answer, because there is no finish reason or incomplete flag on `chat_messages`.
4. **No usage in history.** Messages carry no usage, so the session total counts only replies streamed in the current view (the label says so). Needs `sessionId` on `/api/usage/models`, or usage on assistant rows.
5. **Dismiss is client-only.** There is no revoke endpoint: a dismissed code stays valid on the server until it expires, and after a reload an unexpired dismissed card shows as pending again.

## 5. Tests

New (74 tests):
- `hooks/use-chat-stream.safety.test.mjs` (25). It replays real server chunk shapes and covers:
  - Confirm sends exactly that card's token while a second card stays pending;
  - no auto-confirm;
  - a double submit in one tick sends once;
  - a stale selection is refused with mapped copy, and the card cannot be confirmed twice;
  - an expired card is not sent;
  - server `CONFIRMATION_EXPIRED` and `CONFIRMATION_USED` show clear copy;
  - an interrupted confirmed change shows outcome unknown;
  - an unacknowledged send reopens the card, and a second confirm then succeeds;
  - the typed fallback works, with no tokens sent;
  - a newer preview supersedes the old card;
  - a model-replayed code does not close the card;
  - dismiss;
  - a card built from `confirmation_required` alone;
  - effect classification of the read, write, outcome-unknown and unknown-tool rows;
  - writes still running at failure become unknown, reads become interrupted;
  - truncation keeps partial text, and Retry resends text and attachments exactly once;
  - provider copy with Retry-After;
  - a request error described from its origin;
  - stop keeps the partial text with Retry;
  - a length cutoff gets no Retry;
  - per-turn usage and session totals (unknown cost stays null);
  - a failed turn counts as a reply without usage;
  - history replay with provider-reused call ids (confirmed, then pending, then confirmable).
- `components/chat/chat-safety.test.mjs` (22). Covers:
  - the card shows count, issues, statuses, not-found, expiry and code;
  - the button sends exactly the code, once;
  - dismiss; disabled while busy;
  - expired, and expiry while open (fake timers);
  - a refusal's copy; read-only typed fallback; confirmed outcome;
  - effect and status labels; the unknown note is always visible; the keyboard toggle; the card wired to controls;
  - an incomplete reply with alert and Retry; the "already ran" warning; no Retry without controls;
  - the usage footer never shows $0 for an unknown cost;
  - cost and token formatting; the session lower bound; report cost; the footer breakdown.
- `hooks/chat-stream-state.test.mjs` (13): code normalisation and extraction; preview parsing; interruption rules; lifecycle helpers; the generic "Stream error" copy.
- `lib/api/chat.test.mjs` (+11):
  - `fetchModelUsage` paths;
  - the `confirmationTokens` body;
  - an error chunk becomes `ChatStreamError` with code and details;
  - EOF without `done` gives `CHAT_STREAM_INTERRUPTED`;
  - nothing is reported after abort;
  - CRLF framing; the request error keeps its status and origin;
  - the effect catalogue counts;
  - all 41 chat codes are mapped and never echo raw text;
  - retryable flags.
- `lib/api/routes.test.mjs`: +2 cases (the `chat.fetchModelUsage` row runs for web and desktop; the completeness guard passes again).
- `hooks/use-chat-stream.test.mjs`: +1 (a stored write call with no stored result loads as outcome unknown; a read loads as interrupted).

Stale tests, updated because behaviour changed on purpose (none are regressions):
- `use-chat-stream.test.mjs`, "error chunk adds error message…" and "onError callback adds error message": they expected the error text written into the assistant's `content`. The failure is now structured (`incomplete.error`) so partial text and the error can both be shown. The tests now assert `content === ''`, `incomplete.reason === 'error'`, the error message, `retry: 'available'` and `status: 'error'`.
- `use-chat-stream.test.mjs`, "loadHistory loads historical messages": it expected a stored call with no stored result to be `completed`. The old client ignored `tool` rows. The test now includes the stored `tool` row, as the server always writes, and keeps the `completed` assertion. A new test pins that a call with no stored result is `unknown` (write) or interrupted (read).
- The `vi.mock('@/lib/api/chat')` in that file became a partial mock (`importOriginal`), so the real `ChatStreamError` and effect catalogue load. Only `sendChatMessage` is stubbed, as before.

## 6. Validation

| Gate | Result |
|---|---|
| `pnpm typecheck` (root) | 11/11 tasks successful |
| `pnpm lint` (root biome list) | 62 files checked, no findings (no desktop-ui files are in the list; desktop-ui `lint` is `tsc --noEmit`, clean) |
| `pnpm --filter @openlinear/desktop-ui test` | vitest **42 files passed + 1 skipped; 703 passed + 1 skipped** (base tree before this work: 39 + 1 skipped files, 629 + 1 skipped tests); fonts check `ok`; scroll check `ok` (p95 16.7 ms, max 16.8 ms, 3 passes) |
| `pnpm --filter @openlinear/desktop-ui build` | success; 19 static routes |
| API tests | not run: no API change |

The build rewrites `apps/desktop-ui/next-env.d.ts`; I reverted that by editing it back.

## 7. Leftovers

- The four API gaps in §4: effect on the stream, a reconciliation event, an incomplete flag on stored messages, and usage per session or message. A server revoke for Dismiss is optional.
- `RATE_LIMITED` / `LLM_RATE_LIMITED`: Retry is not held back until `retryAfterMs` passes; the hint says how long to wait.
- The usage view shows the caller's own calls only, as the API scopes it. Workspace-admin totals need an owner decision (ai.md §4.4).
- No end-to-end run against a live API plus the fake LLM provider: everything was tested with recorded server chunk shapes taken from the server code. Worth a manual pass once the API runs locally.
- `BulkPreviewCard` keeps its hover-only edit and remove buttons, which are not reachable by keyboard. It is unused, so I left it alone.

## 8. Merge hazards

- `lib/api/errors.ts`:
  - 4 `CHAT_*` copy constants added after `REFRESH_HINT`;
  - two new sections appended at the end of `API_ERROR_COPY`, after `RATE_LIMITED`.
  - Anyone else appending there gets a textual conflict: keep both sides.
- `lib/api/routes.test.mjs`: one `CASES` row after `chat.sendChatMessage`.
- `lib/api/chat.ts`:
  - `ChatMessage.name` is now optional, and `toolName` was added;
  - `ChatChunk`, `ChatToolResult` and `usage` were widened;
  - errors passed to `onError` are now `ChatStreamError` (still `Error`/`ApiError`);
  - a bare EOF now calls `onError` (`CHAT_STREAM_INTERRUPTED`) instead of `onDone`.
- `hooks/use-chat-stream.tsx` was rewritten.
  - `StreamingMessage`/`StreamingToolCall` now live in `hooks/chat-stream-state.ts` and are re-exported from the hook, so existing imports still work.
  - `StreamingToolCall.status` gained `'unknown' | 'needs_confirmation'`. Nothing outside `components/chat` switches on it.
- `components/brainstorm/brainstorm-drawer.tsx` (outside my listed ownership; it consumes this hook): +2 lines (destructure `controls`, pass `controls={controls}`). Without them the drawer still works, but its confirmation cards offer only the typed code and no Retry.
- `components/chat/chat-usage-view.tsx` imports `components/ui/popover` (not edited). If the focus-styles engineer changes `PopoverContent`'s props, check this file.
- `components/chat/chat-panel.tsx` now calls `useWorkspace()`; the provider is already above it, since `ChatSessionsProvider` requires it.
