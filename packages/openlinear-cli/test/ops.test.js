const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { main, isOpsCommand, safe, safeLine, writePrivateFile, CONTINUE_MESSAGE } = require('../lib/ops');

/**
 * W20 ops CLI against a recorded fake fetch: which service each command
 * calls (cloud API vs local sidecar), with what, the token only in the
 * header, identifier resolution, human and JSON output, exit codes — and
 * the 2026-10-27 security review fixes (terminal escapes, token checks, URL
 * rules, lookup paging, export file handling, timeouts and size caps,
 * argument strictness, deterministic remember keys).
 */

const TASK_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '99999999-2222-4333-8444-555555555555';
const PROJECT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const API = 'https://api.example.test';
const SIDECAR = 'http://127.0.0.1:4555';

function harness(routes, env = {}, extra = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const files = new Map();
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, redirect: init.redirect, signal: init.signal, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const key = `${init.method} ${url}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: 'not found', code: 'NOT_FOUND', message: `no fake route ${key}` }), { status: 404 });
    if (route instanceof Error) throw route;
    if (typeof route === 'function') return route(init);
    if ('raw' in route) return new Response(route.raw, { status: route.status ?? 200, headers: route.headers });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  };
  const io = {
    env: { OPENLINEAR_TOKEN: 'ol_pat_secret', OPENLINEAR_API_URL: API, OPENLINEAR_SIDECAR_URL: SIDECAR, ...env },
    fetch,
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    writeFile: (file, text, options) => files.set(file, { text, options }),
    exists: (file) => files.has(file),
    ...extra,
  };
  return { io, calls, out: () => out.join(''), err: () => err.join(''), files };
}

const lookupUrl = (id, cursor) => `${API}/api/tasks?q=${id}&identifier=${id}&view=compact&pagination=cursor&pageSize=100${cursor ? `&cursor=${cursor}` : ''}`;

const LOOKUP = { [`GET ${lookupUrl('ENG-12')}`]: { body: { items: [{ id: TASK_ID, identifier: 'ENG-12', title: 'Fix login' }, { id: OTHER_ID, identifier: 'ENG-120', title: 'x' }], nextCursor: null, hasMore: false } } };

/** C0 (except newline and tab), DEL, C1 and bidi controls — what must never reach a terminal raw. */
function hasControl(text, allowLines = true) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (allowLines && (code === 0x0a || code === 0x09)) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI8 = String.fromCharCode(0x9b);
const RLO = String.fromCharCode(0x202e);

test('knows its commands; anything else still launches the app', () => {
  for (const name of ['issues', 'status', 'run', 'export', 'knowledge', 'remember', 'help', '--help']) assert.equal(isOpsCommand(name), true);
  for (const name of [undefined, 'install', '--some-app-flag', 'open']) assert.equal(isOpsCommand(name), false);
  assert.equal(isOpsCommand('--json', 'whoami'), true);
  assert.equal(isOpsCommand('--json', 'install'), false);
  assert.equal(isOpsCommand('--json', undefined), false);
  assert.equal(isOpsCommand('--json', '--json'), false);
});

test('lists issues from the cloud API with the token only in the Authorization header', async () => {
  const h = harness({ [`GET ${API}/api/tasks?projectId=${PROJECT}&pageSize=50&status=todo`]: { body: { items: [{ id: TASK_ID, identifier: 'ENG-12', status: 'todo', title: 'Fix login' }] } } });
  assert.equal(await main(['issues', '--project', PROJECT, '--status', 'todo'], h.io), 0);
  assert.match(h.out(), /ENG-12\s+todo\s+Fix login/);
  assert.equal(h.calls[0].headers.authorization, 'Bearer ol_pat_secret');
  assert.equal(h.calls[0].redirect, 'error');
  assert.ok(h.calls[0].signal instanceof AbortSignal);
  assert.ok(!h.calls[0].url.includes('ol_pat_secret'));
  assert.ok(!h.out().includes('ol_pat_secret'));
});

test('resolves ENG-12 exactly (not ENG-120) with the identifier filter and reads the run from the local sidecar', async () => {
  const run = { runId: 'run-1', state: 'succeeded', runner: 'claude-code', terminal: { outcome: 'PR opened' }, verification: { status: 'passed' },
    phases: { queuedMs: 0, preparingMs: 13_000, setupMs: 7_000, agentMs: 65_000, approvalWaitMs: 0, verifyingMs: 15_000, finishingMs: 5_000, totalMs: 100_000, live: false } };
  const h = harness({ ...LOOKUP, [`GET ${SIDECAR}/api/tasks/${TASK_ID}/run`]: { body: { run } } });
  assert.equal(await main(['status', 'ENG-12'], h.io), 0);
  assert.deepEqual(h.calls.map((call) => call.url), [lookupUrl('ENG-12'), `${SIDECAR}/api/tasks/${TASK_ID}/run`]);
  assert.match(h.out(), /Run run-1 · succeeded · claude-code/);
  assert.match(h.out(), /Outcome: PR opened/);
  assert.match(h.out(), /Time: 1m 40s \(Preparing 13s, Agent 1m 5s, Verifying 15s, Publishing 5s\)/);
});

test('run, cancel and continue go to the sidecar with the right bodies', async () => {
  const h = harness({
    ...LOOKUP,
    [`POST ${SIDECAR}/api/tasks/${TASK_ID}/execute`]: { status: 202, body: { runId: 'run-2', state: 'preparing' } },
    [`POST ${SIDECAR}/api/tasks/${TASK_ID}/cancel`]: { body: { message: 'Task cancelled' } },
    [`POST ${SIDECAR}/api/tasks/${TASK_ID}/follow-up`]: { status: 202, body: { runId: 'run-3', state: 'queued' } },
  });
  assert.equal(await main(['run', 'ENG-12', '--allow-blocked'], h.io), 0);
  assert.equal(await main(['cancel', TASK_ID], h.io), 0);
  assert.equal(await main(['continue', TASK_ID], h.io), 0);
  assert.equal(await main(['continue', TASK_ID, '-m', 'Only fix the null check'], h.io), 0);
  const posts = h.calls.filter((call) => call.method === 'POST');
  assert.deepEqual(posts.map((call) => call.body), [{ allowBlocked: true }, {}, { message: CONTINUE_MESSAGE, comments: [] }, { message: 'Only fix the null check', comments: [] }]);
  assert.match(h.out(), /Started run run-2 \(preparing\)/);
  assert.match(h.out(), /Cancelled\./);
  assert.match(h.out(), /Continuing in run run-3 \(queued\)/);
});

test('cancel: 202 says it is still in progress, never "Cancelled."; old { success: true } still reads as cancelled', async () => {
  const pending = harness({ [`POST ${SIDECAR}/api/tasks/${TASK_ID}/cancel`]: { status: 202, body: { error: 'Cancellation is still in progress', state: 'cancelling' } } });
  assert.equal(await main(['cancel', TASK_ID], pending.io), 0);
  assert.match(pending.out(), /Cancelling… \(still in progress\)/);
  assert.doesNotMatch(pending.out(), /Cancelled\./);
  const old = harness({ [`POST ${SIDECAR}/api/tasks/${TASK_ID}/cancel`]: { body: { success: true } } });
  assert.equal(await main(['cancel', TASK_ID], old.io), 0);
  assert.equal(old.out(), 'Cancelled.\n');
});

test('export writes the JSON file; --json prints the API body as-is', async () => {
  const exported = { version: 1, project: { id: PROJECT }, tasks: [] };
  const h = harness({ [`GET ${API}/api/projects/${PROJECT}/export`]: { body: exported }, [`GET ${API}/api/projects/${PROJECT}/knowledge`]: { body: { entries: [] } } });
  assert.equal(await main(['export', PROJECT, '-o', 'out.json'], h.io), 0);
  assert.deepEqual(JSON.parse(h.files.get('out.json').text), exported);
  assert.deepEqual(h.files.get('out.json').options, { force: false });
  assert.equal(await main(['knowledge', PROJECT, '--json'], h.io), 0);
  assert.match(h.out(), /"entries": \[\]/);
  // An existing target is refused before the download.
  const before = h.calls.length;
  assert.equal(await main(['export', PROJECT, '-o', 'out.json'], h.io), 2);
  assert.match(h.err(), /out\.json already exists; pass --force/);
  assert.equal(h.calls.length, before);
  assert.equal(await main(['export', PROJECT, '-o', 'out.json', '--force'], h.io), 0);
  assert.deepEqual(h.files.get('out.json').options, { force: true });
});

test('remember proposes knowledge with a deterministic idempotency key and says a person approves it', async () => {
  const h = harness({ [`POST ${API}/api/projects/${PROJECT}/knowledge`]: { status: 201, body: { id: 'k1', title: 'Use pnpm', status: 'proposed' } } });
  assert.equal(await main(['remember', PROJECT, '--title', 'Use pnpm', '--body', 'Never npm', '--kind', 'convention'], h.io), 0);
  assert.deepEqual(h.calls[0].body, { kind: 'convention', title: 'Use pnpm', body: 'Never npm' });
  const key = h.calls[0].headers['idempotency-key'];
  assert.match(key, /^cli-[0-9a-f]{64}$/);
  assert.match(h.out(), /Proposed "Use pnpm"; a person approves it/);
  // A retry (after a timeout, say) sends the same key; other content does not.
  assert.equal(await main(['remember', PROJECT, '--title', 'Use pnpm', '--body', 'Never npm', '--kind', 'convention'], h.io), 0);
  assert.equal(h.calls[1].headers['idempotency-key'], key);
  assert.equal(await main(['remember', PROJECT.toUpperCase(), '--title', 'Use pnpm', '--body', 'Never npm', '--kind', 'convention'], h.io), 0);
  assert.equal(h.calls[2].headers['idempotency-key'], key);
  assert.equal(await main(['remember', PROJECT, '--title', 'Use pnpm', '--body', 'Never yarn', '--kind', 'convention'], h.io), 0);
  assert.notEqual(h.calls[3].headers['idempotency-key'], key);
  assert.equal(await main(['remember', PROJECT, '--title', 'Use pnpm', '--body', 'Never npm', '--kind', 'note'], h.io), 0);
  assert.notEqual(h.calls[4].headers['idempotency-key'], key);
});

test('insights summarise rates, time, cost and delivery', async () => {
  const body = {
    runs: { total: 10, successRate: 0.8, verification: { passRate: 0.75 }, publication: { rate: 0.6 }, duration: { medianMs: 300_000, p90Ms: 900_000 }, cost: { knownUsd: 4.5, unknownCostRuns: 2 } },
    delivery: { created: 12, completed: 9, openNow: 5, blockedNow: 1 },
  };
  const h = harness({ [`GET ${API}/api/projects/${PROJECT}/insights?range=7d`]: { body } });
  assert.equal(await main(['insights', PROJECT, '--range', '7d'], h.io), 0);
  assert.match(h.out(), /Runs 10 · success 80% · verified 75% · PR 60%/);
  assert.match(h.out(), /Run time median 5m 0s · p90 15m 0s/);
  assert.match(h.out(), /Cost \$4\.50 \+ 2 run\(s\) with unknown cost/);
  assert.match(h.out(), /Issues created 12 · completed 9 · open 5 · blocked 1/);
});

test('exit codes: usage 2, no token or refused token 3, API refusal 1, unreachable sidecar 1 with a hint', async () => {
  const usage = harness({});
  assert.equal(await main(['issues'], usage.io), 2);
  assert.equal(await main(['insights', PROJECT, '--range', '1y'], usage.io), 2);
  assert.equal(await main(['status', 'not an id'], usage.io), 2);
  assert.equal(await main(['frobnicate'], usage.io), 2);
  assert.equal(usage.calls.length, 0);

  const noToken = harness({}, { OPENLINEAR_TOKEN: '' });
  assert.equal(await main(['whoami'], noToken.io), 3);
  assert.equal(noToken.calls.length, 0);

  const refused = harness({ [`GET ${API}/api/users/me`]: { status: 401, body: { error: 'Invalid token', code: 'UNAUTHORIZED' } } });
  assert.equal(await main(['whoami'], refused.io), 3);
  assert.match(refused.err(), /UNAUTHORIZED: Invalid token/);

  const blocked = harness({ ...LOOKUP, [`POST ${SIDECAR}/api/tasks/${TASK_ID}/execute`]: { status: 409, body: { error: 'blocked', code: 'TASK_BLOCKED', message: 'This task is blocked by ENG-11' } } });
  assert.equal(await main(['run', 'ENG-12'], blocked.io), 1);
  assert.match(blocked.err(), /TASK_BLOCKED: This task is blocked by ENG-11/);

  const down = harness({ [`GET ${SIDECAR}/api/tasks/${TASK_ID}/logs`]: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }) });
  assert.equal(await main(['logs', TASK_ID], down.io), 1);
  assert.match(down.err(), /UNREACHABLE: Could not reach the local sidecar at http:\/\/127\.0\.0\.1:4555 \(is the OpenLinear app running\?\) \(ECONNREFUSED\)/);
});

test('an identifier that matches nothing or several issues is refused', async () => {
  const none = harness({ [`GET ${lookupUrl('ENG-99')}`]: { body: { items: [], nextCursor: null } } });
  assert.equal(await main(['issue', 'ENG-99'], none.io), 1);
  assert.match(none.err(), /TASK_NOT_FOUND/);
  const two = harness({ [`GET ${lookupUrl('ENG-12')}`]: { body: { items: [{ id: TASK_ID, identifier: 'ENG-12' }, { id: OTHER_ID, identifier: 'eng-12' }], nextCursor: null } } });
  assert.equal(await main(['issue', 'ENG-12'], two.io), 1);
  assert.match(two.err(), /AMBIGUOUS_IDENTIFIER/);
});

// ─── 2026-10-27 security review fixes ───────────────────────────────────────

test('terminal escapes from the server are neutralised in human output (one-line fields keep one line)', async () => {
  const title = `Fix ${ESC}]0;pwned${BEL}login${ESC}[2J\nFAKE-1 done Injected ${RLO}gnp.exe${CSI8}31m`;
  const h = harness({
    [`GET ${API}/api/tasks?projectId=${PROJECT}&pageSize=50`]: { body: { items: [{ id: TASK_ID, identifier: `ENG-12${ESC}[8m`, status: `todo\r`, title }] } },
    [`GET ${API}/api/tasks/${TASK_ID}`]: { body: { id: TASK_ID, identifier: 'ENG-12', title, status: 'todo', description: `line 1\n\tindented ${ESC}[31mred${String.fromCharCode(0x7f)}\rover`, blockedBy: [{ identifier: `ENG-1${ESC}[A`, status: 'todo' }], plan: { title: `Plan${String.fromCharCode(0x2066)}` } } },
    [`GET ${SIDECAR}/api/tasks/${TASK_ID}/logs`]: { body: { logs: [{ timestamp: '2026-10-27T10:00:00Z', type: `info${ESC}[K`, message: `building\n${ESC}]52;c;ZWNobyBoaQ==${BEL}done` }] } },
    [`GET ${SIDECAR}/api/tasks/${TASK_ID}/run`]: { body: { run: { runId: `run${ESC}[1A`, state: 'running', terminal: { outcome: `ok${String.fromCharCode(0x200f)}` } } } },
    [`GET ${API}/api/projects/${PROJECT}/knowledge`]: { body: { entries: [{ kind: 'note', status: 'active', title: `T${ESC}c`, body: `first\nsecond ${ESC}[5m` }] } },
    [`GET ${API}/api/users/me`]: { body: { username: `me${ESC}[2J`, email: `a@b${String.fromCharCode(0x061c)}` } },
  });
  for (const argv of [['issues', '--project', PROJECT], ['issue', TASK_ID], ['logs', TASK_ID], ['status', TASK_ID], ['knowledge', PROJECT], ['whoami']]) {
    assert.equal(await main(argv, h.io), 0, argv.join(' '));
  }
  const out = h.out();
  assert.equal(hasControl(out), false);
  assert.match(out, /Fix \\u001b\]0;pwned\\u0007login\\u001b\[2J\\u000aFAKE-1 done Injected \\u202egnp\.exe\\u009b31m/);
  // The issue list stays one line per issue.
  assert.match(out, /ENG-12\\u0\S* todo\\u000d +Fix /);
  // Multi-line fields keep their newlines and tabs; CR is escaped.
  assert.match(out, /line 1\n\tindented \\u001b\[31mred\\u007f\\u000dover/);
  assert.match(out, /building\n\\u001b\]52;c;ZWNobyBoaQ==\\u0007done/);
  assert.match(out, /\[note\] T\\u001bc\n {2}first\n {2}second \\u001b\[5m/);
  assert.match(out, /Blocked by: ENG-1\\u001b\[A \(todo\)/);
  assert.match(out, /Plan: Plan\\u2066/);
  assert.match(out, /Outcome: ok\\u200f/);
  assert.match(out, /me\\u001b\[2J <a@b\\u061c>/);
  assert.equal(h.err(), '');
});

test('--json stays JSON that parses to the server value, with no raw controls', async () => {
  const me = { username: `me${ESC}[2J${CSI8}${RLO}`, note: 'line\nbreak' };
  const h = harness({ [`GET ${API}/api/users/me`]: { body: me } });
  assert.equal(await main(['whoami', '--json'], h.io), 0);
  assert.deepEqual(JSON.parse(h.out()), me);
  assert.equal(hasControl(h.out()), false);
});

test('escapes on stderr: server codes and messages, echoed user input', async () => {
  const h = harness({ [`GET ${API}/api/users/me`]: { status: 409, body: { code: `EVIL${ESC}[2J`, message: `bad${ESC}]0;title${BEL}\nFAKE: ok${RLO}` } } });
  assert.equal(await main(['whoami'], h.io), 1);
  assert.equal(await main([`frob${ESC}[2J`], h.io), 2);
  assert.equal(await main(['status', `ENG${ESC}[2J`], h.io), 2);
  assert.equal(await main(['whoami', `x${ESC}[2J`], h.io), 2);
  assert.equal(await main(['whoami', `--x${ESC}[2J`], h.io), 2);
  const err = h.err();
  assert.equal(hasControl(err), false);
  assert.match(err, /^EVIL\\u001b\[2J: bad\\u001b\]0;title\\u0007\\u000aFAKE: ok\\u202e$/m);
  assert.match(err, /Unknown command: frob\\u001b\[2J/);
  assert.match(err, /Not a task id or identifier: ENG\\u001b\[2J/);
  assert.match(err, /Unexpected argument: x\\u001b\[2J/);
  assert.match(err, /--x\\u001b\[2J/);
});

test('safe() keeps newlines and tabs; safeLine() escapes them; printable text and other Unicode pass through', () => {
  assert.equal(safe(`a\n\tb${ESC}c\r`), 'a\n\tb\\u001bc\\u000d');
  assert.equal(safeLine(`a\n\tb`), 'a\\u000a\\u0009b');
  assert.equal(safeLine('Ünïcødé — 日本 🚀 · ok'), 'Ünïcødé — 日本 🚀 · ok');
  assert.equal(safeLine(String.fromCharCode(0x85, 0x9f, 0xa0)), `\\u0085\\u009f${String.fromCharCode(0xa0)}`);
  assert.equal(safeLine(null), '');
});

test('a token with a newline or control character is refused before any request and never echoed', async () => {
  for (const token of ['ol_pat_abc\ndef', 'ol_pat_abc\rdef', 'ol_pat_abc\u0000def', 'ol_pat_abc def']) {
    const h = harness({}, { OPENLINEAR_TOKEN: token });
    assert.equal(await main(['whoami'], h.io), 3);
    assert.equal(h.calls.length, 0);
    assert.match(h.err(), /^INVALID_TOKEN: /);
    assert.ok(!h.err().includes('ol_pat_abc'));
    assert.ok(!h.out().includes('ol_pat_abc'));
  }
});

test('fetch error messages are never printed (they can carry the Authorization header)', async () => {
  const leak = new TypeError('Headers.append: "Bearer ol_pat_secret" is an invalid header value.');
  const h = harness({ [`GET ${API}/api/users/me`]: leak });
  assert.equal(await main(['whoami'], h.io), 1);
  assert.match(h.err(), /UNREACHABLE: Could not reach the OpenLinear API at https:\/\/api\.example\.test \(TypeError\)/);
  assert.ok(!h.err().includes('ol_pat_secret'));
  assert.ok(!h.err().includes('invalid header'));
});

test('URLs: https required except loopback; no user info, query or fragment', async () => {
  const refuse = [
    { OPENLINEAR_API_URL: 'http://api.example.test' },
    { OPENLINEAR_API_URL: 'http://10.0.0.5:3001' },
    { OPENLINEAR_API_URL: 'http://localhost.evil.test' },
    { OPENLINEAR_SIDECAR_URL: 'http://192.168.1.20:3003' },
    { OPENLINEAR_API_URL: 'https://user:hunter2@api.example.test' },
    { OPENLINEAR_API_URL: 'https://user@api.example.test' },
    { OPENLINEAR_API_URL: 'https://api.example.test/?x=1' },
    { OPENLINEAR_API_URL: 'https://api.example.test/?' },
    { OPENLINEAR_API_URL: 'https://api.example.test/#frag' },
    { OPENLINEAR_API_URL: 'ftp://api.example.test' },
    { OPENLINEAR_API_URL: 'not a url' },
  ];
  for (const env of refuse) {
    const h = harness({}, env);
    assert.equal(await main(['whoami'], h.io), 2, JSON.stringify(env));
    assert.equal(h.calls.length, 0);
    assert.ok(!h.err().includes('hunter2'));
  }
  for (const url of ['http://localhost:3001', 'http://127.0.0.5:3001', 'http://[::1]:3001', 'https://api.example.test/base/']) {
    const h = harness({}, { OPENLINEAR_API_URL: url });
    await main(['whoami'], h.io);
    assert.equal(h.calls.length, 1, url);
    assert.equal(h.calls[0].url, `${url.replace(/\/$/, '')}/api/users/me`);
    assert.equal(h.calls[0].redirect, 'error');
  }
});

test('identifier lookup follows nextCursor and still matches exactly', async () => {
  const h = harness({
    [`GET ${lookupUrl('ENG-12')}`]: { body: { items: [{ id: OTHER_ID, identifier: 'ENG-120' }], nextCursor: 'c1', hasMore: true } },
    [`GET ${lookupUrl('ENG-12', 'c1')}`]: { body: { items: [{ id: TASK_ID, identifier: 'eng-12' }], nextCursor: null, hasMore: false } },
    [`GET ${API}/api/tasks/${TASK_ID}`]: { body: { id: TASK_ID, identifier: 'ENG-12', title: 'Fix login', status: 'todo' } },
  });
  assert.equal(await main(['issue', 'ENG-12'], h.io), 0);
  assert.deepEqual(h.calls.map((call) => call.url), [lookupUrl('ENG-12'), lookupUrl('ENG-12', 'c1'), `${API}/api/tasks/${TASK_ID}`]);
  assert.match(h.out(), /ENG-12 {2}Fix login/);

  const across = harness({
    [`GET ${lookupUrl('ENG-12')}`]: { body: { items: [{ id: TASK_ID, identifier: 'ENG-12' }], nextCursor: 'c1', hasMore: true } },
    [`GET ${lookupUrl('ENG-12', 'c1')}`]: { body: { items: [{ id: OTHER_ID, identifier: 'ENG-12' }], nextCursor: null } },
  });
  assert.equal(await main(['issue', 'ENG-12'], across.io), 1);
  assert.match(across.err(), /AMBIGUOUS_IDENTIFIER/);
});

test('identifier lookup refuses when the results were not exhausted (5 pages, or an old API with hasMore and no cursor)', async () => {
  const routes = {};
  for (let page = 0; page < 6; page += 1) {
    routes[`GET ${lookupUrl('ENG-12', page === 0 ? undefined : `c${page}`)}`] = { body: { items: page === 2 ? [{ id: TASK_ID, identifier: 'ENG-12' }] : [], nextCursor: `c${page + 1}`, hasMore: true } };
  }
  const deep = harness({ ...routes, [`POST ${SIDECAR}/api/tasks/${TASK_ID}/execute`]: { status: 202, body: {} } });
  assert.equal(await main(['run', 'ENG-12'], deep.io), 1);
  assert.match(deep.err(), /^IDENTIFIER_LOOKUP_INCOMPLETE: .*pass the task id\./);
  assert.equal(deep.calls.length, 5);
  assert.ok(deep.calls.every((call) => call.method === 'GET'));

  const old = harness({ [`GET ${lookupUrl('ENG-12')}`]: { body: { items: [{ id: TASK_ID, identifier: 'ENG-12' }], page: 1, pageSize: 100, total: 250, hasMore: true } } });
  assert.equal(await main(['cancel', 'ENG-12'], old.io), 1);
  assert.match(old.err(), /IDENTIFIER_LOOKUP_INCOMPLETE/);
  assert.equal(old.calls.length, 1);

  const badId = harness({ [`GET ${lookupUrl('ENG-12')}`]: { body: { items: [{ id: '..', identifier: 'ENG-12' }], nextCursor: null } } });
  assert.equal(await main(['logs', 'ENG-12'], badId.io), 1);
  assert.match(badId.err(), /BAD_RESPONSE/);
  assert.equal(badId.calls.length, 1);
});

test('a non-JSON or empty 2xx body is a failure, not success', async () => {
  for (const raw of ['<html>OK</html>', '']) {
    const h = harness({ [`POST ${SIDECAR}/api/tasks/${TASK_ID}/cancel`]: { status: 200, raw } });
    assert.equal(await main(['cancel', TASK_ID], h.io), 1);
    assert.match(h.err(), /^BAD_RESPONSE: POST \/api\/tasks\/[0-9a-f-]+\/cancel answered 200 with /);
    assert.doesNotMatch(h.out(), /Cancelled/);
  }
});

test('project ids must be UUIDs (no ".." or "." reaching other routes)', async () => {
  const h = harness({});
  for (const argv of [['export', '..'], ['insights', '.'], ['knowledge', '../users'], ['remember', '..', '--title', 't', '--body', 'b'], ['issues', '--project', '..'], ['export', `${PROJECT}/..`]]) {
    assert.equal(await main(argv, h.io), 2, argv.join(' '));
  }
  assert.equal(h.calls.length, 0);
  assert.match(h.err(), /Not a project id \(expected a UUID\): \.\./);
});

test('a request that never answers times out (export gets the longer limit)', async () => {
  const slow = (delayMs) => (init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({ version: 1 }), { status: 200 })), delayMs);
    init.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(init.signal.reason);
    });
  });
  const never = harness({ [`GET ${API}/api/users/me`]: slow(60_000) }, {}, { limits: { timeoutMs: 30 } });
  const started = Date.now();
  assert.equal(await main(['whoami'], never.io), 1);
  assert.ok(Date.now() - started < 5_000);
  assert.match(never.err(), /^TIMEOUT: No answer to GET \/api\/users\/me from the OpenLinear API at https:\/\/api\.example\.test within 30ms\./);

  const limits = { timeoutMs: 20, exportTimeoutMs: 2_000 };
  const exp = harness({ [`GET ${API}/api/projects/${PROJECT}/export`]: slow(80), [`GET ${API}/api/users/me`]: slow(80) }, {}, { limits });
  assert.equal(await main(['export', PROJECT], exp.io), 0);
  assert.deepEqual(JSON.parse(exp.out()), { version: 1 });
  assert.equal(await main(['whoami'], exp.io), 1);
  assert.match(exp.err(), /TIMEOUT/);
});

test('an oversized body is abandoned while it is read (no Content-Length needed)', async () => {
  let cancelled = false;
  let pulled = 0;
  const endless = () => new Response(new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(1024).fill(0x20));
    },
    cancel() {
      cancelled = true;
    },
  }), { status: 200 });
  const h = harness({ [`GET ${API}/api/users/me`]: endless }, {}, { limits: { maxBytes: 4096 } });
  assert.equal(await main(['whoami'], h.io), 1);
  assert.match(h.err(), /^RESPONSE_TOO_LARGE: The answer to GET \/api\/users\/me is larger than 4096 bytes\./);
  assert.ok(pulled <= 8, `read ${pulled} chunks`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);

  const declared = harness({ [`GET ${API}/api/users/me`]: { raw: '{}', headers: { 'content-length': String(64 * 1024 * 1024) } } });
  assert.equal(await main(['whoami'], declared.io), 1);
  assert.match(declared.err(), /RESPONSE_TOO_LARGE: .*larger than 32 MiB/);

  // Export has its own (larger) cap.
  const big = JSON.stringify({ blob: 'x'.repeat(10_000) });
  const exp = harness({ [`GET ${API}/api/projects/${PROJECT}/export`]: { raw: big }, [`GET ${API}/api/users/me`]: { raw: big } }, {}, { limits: { maxBytes: 1024, exportMaxBytes: 64 * 1024 } });
  assert.equal(await main(['export', PROJECT], exp.io), 0);
  assert.equal(await main(['whoami'], exp.io), 1);
});

test('extra positionals, options that do not apply and empty values are refused', async () => {
  const h = harness({});
  for (const argv of [
    ['whoami', 'extra'],
    ['status', TASK_ID, 'extra'],
    ['export', PROJECT, 'out.json'],
    ['whoami', '--project', PROJECT],
    ['cancel', TASK_ID, '-m', 'hi'],
    ['status', TASK_ID, '--force'],
    ['issue', TASK_ID, '--allow-blocked'],
    ['issues', '--project', PROJECT, '--limit', ''],
    ['issues', '--project', PROJECT, '--limit', '10x'],
    ['issues', '--project', PROJECT, '--status', ''],
    ['export', PROJECT, '-o', ''],
    ['continue', TASK_ID, '-m', '  '],
    ['insights', PROJECT, '--range', ''],
  ]) {
    assert.equal(await main(argv, h.io), 2, argv.join(' '));
  }
  assert.equal(h.calls.length, 0);
  assert.match(h.err(), /Unexpected argument: extra/);
  assert.match(h.err(), /--project does not apply to "whoami"\./);
  assert.match(h.err(), /--limit needs a value\./);
});

test('openlinear --json whoami works like openlinear whoami --json', async () => {
  const me = { id: 'u1', username: 'kaizen', email: 'k@example.test' };
  const h = harness({ [`GET ${API}/api/users/me`]: { body: me } });
  assert.equal(await main(['--json', 'whoami'], h.io), 0);
  assert.deepEqual(JSON.parse(h.out()), me);
  const human = harness({ [`GET ${API}/api/users/me`]: { body: me } });
  assert.equal(await main(['whoami'], human.io), 0);
  assert.equal(human.out(), 'kaizen <k@example.test>\n');
});

// ─── Export writer on a real filesystem ─────────────────────────────────────

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openlinear-cli-test-'));
}

const mode = (file) => fs.statSync(file).mode & 0o777;
const leftovers = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));

test('writePrivateFile: new file is 0600; an existing file is refused without --force and replaced 0600 with it', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'export.json');
  writePrivateFile(target, 'one');
  assert.equal(fs.readFileSync(target, 'utf8'), 'one');
  assert.equal(mode(target), 0o600);

  const existing = path.join(dir, 'existing.json');
  fs.writeFileSync(existing, 'keep');
  fs.chmodSync(existing, 0o644);
  assert.throws(() => writePrivateFile(existing, 'new'), /already exists; pass --force/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep');
  writePrivateFile(existing, 'new', { force: true });
  assert.equal(fs.readFileSync(existing, 'utf8'), 'new');
  assert.equal(mode(existing), 0o600);
  assert.deepEqual(leftovers(dir), []);
});

test('writePrivateFile: a symlink target is refused, and --force replaces the link instead of writing through it', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'precious');
  fs.chmodSync(victim, 0o644);
  const link = path.join(dir, 'export.json');
  fs.symlinkSync(victim, link);
  assert.throws(() => writePrivateFile(link, 'data'), /already exists/);
  const dangling = path.join(dir, 'dangling.json');
  fs.symlinkSync(path.join(dir, 'missing.txt'), dangling);
  assert.throws(() => writePrivateFile(dangling, 'data'), /already exists/);
  assert.equal(fs.existsSync(path.join(dir, 'missing.txt')), false);

  writePrivateFile(link, 'data', { force: true });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(link, 'utf8'), 'data');
  assert.equal(mode(link), 0o600);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious');
  assert.equal(mode(victim), 0o644);
  assert.deepEqual(leftovers(dir), []);
});

test('writePrivateFile: a failed write leaves no temp file behind', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sub = path.join(dir, 'a-directory');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'inside'), 'x');
  assert.throws(() => writePrivateFile(sub, 'data', { force: true }), (error) => error.code === 'WRITE_FAILED');
  assert.deepEqual(leftovers(dir), []);
  assert.throws(() => writePrivateFile(path.join(dir, 'missing-dir', 'out.json'), 'data'), (error) => error.code === 'WRITE_FAILED');
});

test('export -o through main on a real filesystem: refuses an existing file, --force writes 0600', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'project.json');
  fs.writeFileSync(target, 'old');
  fs.chmodSync(target, 0o644);
  const exported = { version: 1, tasks: [] };
  const h = harness({ [`GET ${API}/api/projects/${PROJECT}/export`]: { body: exported } }, {}, { writeFile: undefined, exists: undefined });
  assert.equal(await main(['export', PROJECT, '-o', target], h.io), 2);
  assert.equal(h.calls.length, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  assert.equal(await main(['export', PROJECT, '-o', target, '--force'], h.io), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), exported);
  assert.equal(mode(target), 0o600);
  assert.deepEqual(leftovers(dir), []);
});
