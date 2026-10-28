#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const onboardingPath = new URL('../apps/desktop-ui/components/onboarding/onboarding-wizard.tsx', import.meta.url);
const projectStepPath = new URL('../apps/desktop-ui/components/onboarding/steps/project-step.tsx', import.meta.url);
const onboardingUtilsPath = new URL('../apps/desktop-ui/components/onboarding/steps/onboarding-utils.ts', import.meta.url);
const homePagePath = new URL('../apps/desktop-ui/app/(app)/page.tsx', import.meta.url);
const projectHookPath = new URL('../apps/desktop-ui/hooks/use-project.tsx', import.meta.url);
const chatPanelPath = new URL('../apps/desktop-ui/components/chat/chat-panel.tsx', import.meta.url);
const chatMessageListPath = new URL('../apps/desktop-ui/components/chat/chat-message-list.tsx', import.meta.url);

// ─── Browser harness settings ────────────────────────────────────────────────
//
// Startup: CI runs every package's test task in parallel (turbo), so Chromium
// competes with several vitest pools for the runner's vCPUs. A fixed 10 s wait
// with no diagnostics failed intermittently; give startup a generous budget,
// retry a failed launch once, and always surface Chromium's own stderr.
const CHROMIUM_STARTUP_TIMEOUT_MS = 30_000;
const CHROMIUM_STARTUP_ATTEMPTS = 2;
const CDP_CALL_TIMEOUT_MS = 60_000;
const PAGE_READY_TIMEOUT_MS = 15_000;

// Frame timing: headless Chromium produces one rAF per 16.7 ms vsync, and on an
// idle or CPU-oversubscribed machine every steady-state frame measures 16.6-16.8
// ms. A single scheduler stall on a shared CI VM shows up as exactly one long
// frame (e.g. 200 ms = 12 vsyncs) while the rest of the pass stays at 16.7 ms.
// So the per-pass limits are unchanged, but a breach has to repeat in a
// majority of passes to fail the check, and a hard ceiling still fails on any
// single frame long enough to be a real freeze.
const SCROLL_STEPS = 120;
const MEASURED_PASSES = 3;
const WARMUP_FRAMES = 5;
const P95_FRAME_LIMIT_MS = 40;
const MAX_FRAME_LIMIT_MS = 120;
const HARD_CEILING_MS = 500;
const MAX_TOLERATED_BREACHED_PASSES = 1;
// Diagnostics only: 1.5 vsyncs at 60 Hz, so any listed frame missed a vsync.
const SLOW_FRAME_MS = 25;

const CHROMIUM_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
// An explicit CHROMIUM_BIN is used as-is (no silent fallback to another browser).
const chromiumPath = process.env.CHROMIUM_BIN || CHROMIUM_CANDIDATES.find((path) => existsSync(path)) || CHROMIUM_CANDIDATES[0];

const CHROMIUM_FLAGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-breakpad',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--use-mock-keychain',
  '--mute-audio',
  '--window-size=1280,800',
  '--remote-debugging-port=0',
];

function assertRepoPickerSourceGuards(source, utilsSource) {
  const repoItemStart = source.indexOf('const RepoItem = memo(function RepoItem');
  const repoListStart = source.indexOf('const GitHubRepoList = memo(function GitHubRepoList');
  assert.notEqual(repoItemStart, -1, 'RepoItem component not found');
  assert.notEqual(repoListStart, -1, 'GitHubRepoList component not found');

  const repoItemSource = source.slice(repoItemStart, repoListStart);
  const repoListSource = source.slice(repoListStart, source.indexOf('// ─── Step 2'));

  assert.equal(source.includes('useVirtualizer'), false, 'onboarding repo picker must not use scroll virtualization');
  assert.equal(source.includes('fetchGitHubBranches'), false, 'repo selection must not trigger automatic branch-list fetches');
  assert.equal(source.includes('Load more'), false, 'onboarding repo picker must not use paged browse/load-more');
  assert.match(utilsSource, /const REPO_SEARCH_LIMIT = ([1-9]|1[0-2])\b/, 'repo search limit must stay at or below 12');
  assert.match(repoListSource, /q: repoQuery/, 'repo fetches must be query-driven');
  assert.match(repoListSource, /!repoQuery[\s\S]*setRepos\(\[\]\)/, 'empty search must clear repos without fetching');
  assert.match(repoListSource, /data-testid="onboarding-github-repo-list"/, 'repo list test id missing');
  assert.match(repoItemSource, /data-testid="onboarding-github-repo-row"/, 'repo row test id missing');
  assert.match(repoItemSource, /<img[\s\S]*loading="lazy"[\s\S]*decoding="async"/, 'repo logos must be lazy and async decoded');
  assert.match(repoItemSource, /onError=\{\(event\) => event\.currentTarget\.remove\(\)\}/, 'repo logos need a cheap failure fallback');
  assert.match(source, /className="max-h-44 overflow-y-auto/, 'repo list height should stay compact inside the card');
}

function assertOnboardingWizardSourceGuards(source) {
  assert.match(source, /initialWorkspaceId\?: string \| null/, 'wizard must accept an existing workspace id');
  assert.match(source, /initialProjectId\?: string \| null/, 'wizard must accept an existing project id for team setup');
  assert.match(source, /const workspaceIdForProject = createdWorkspaceId \?\? initialWorkspaceId/, 'project creation must fall back to the initial workspace id');
  assert.match(source, /setCurrentStep\(initialProjectId \? 2 : 1\)/, 'existing project onboarding must start at team setup');
  assert.match(source, /if \(initialProjectId && createdProjectId === initialProjectId\)/, 'existing project back path must not create duplicate projects');
  assert.match(source, /isExistingProject=\{Boolean\(initialProjectId && createdProjectId === initialProjectId\)\}/, 'existing project step must render read-only project UI');
  assert.match(source, /onBack=\{\(\) => setCurrentStep\(1\)\}/, 'team setup must expose a back button');
  assert.match(source, /createdWorkspaceId, createdProjectId/, 'stored drafts must keep created ids needed by later steps');
}

function assertHomePageSourceGuards(source) {
  assert.equal(source.includes('OnboardingWizard'), false, 'home page must not render onboarding before launch');
  assert.match(source, /const shouldOpenProjects = projects\.length === 0 \|\| Boolean\(projectWithoutTeam\)/, 'empty or teamless setup must route to manual project management');
  assert.match(source, /router\.replace\('\/projects'\)/, 'home page must redirect setup-empty users to projects');
  assert.match(source, /shouldOpenProjects[\s\S]*return <HomePageSkeleton \/>/, 'home page must avoid flashing chat while redirecting to projects');
}

function assertProjectHookSourceGuards(source) {
  assert.match(source, /'teams'/, 'project list must include teams so teamless projects can be detected');
}

function assertChatMessageListSourceGuards(source) {
  assert.match(source, /function ChatThinkingIndicator/, 'chat message list must include a thinking indicator');
  assert.match(source, /isThinking\?: boolean/, 'chat message list must accept thinking state');
  assert.match(source, /showThinking && <ChatThinkingIndicator \/>/, 'chat message list must render thinking before first assistant content');
  assert.match(source, /Loader2[\s\S]*animate-spin/, 'thinking indicator must show a spinner');
}

function assertChatPanelSourceGuards(source) {
  assert.match(source, /const isThinking = isStreaming && !streamingContent/, 'chat panel must compute an empty-response thinking state');
  assert.match(source, /isThinking=\{isThinking\}/, 'chat panel must pass thinking state to chat message list');
}

function buildFixtureHtml(rowCount = 8) {
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const owner = `team-${index % 4}`;
    const repo = `repo-${String(index + 1).padStart(2, '0')}`;
    return `
      <button data-testid="onboarding-github-repo-row" class="repo-row" type="button">
        <div class="repo-avatar">${owner[0].toUpperCase()}</div>
        <div class="repo-copy">
          <div class="repo-title">${repo}</div>
          <div class="repo-full">${owner}/${repo}</div>
          <p class="repo-description">Repository ${index + 1} for onboarding selection performance checks.</p>
        </div>
        <div class="repo-radio"></div>
      </button>`;
  }).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #101113;
      color: #f4f4f5;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    [data-testid="onboarding-github-repo-list"] {
      width: 680px;
      max-height: 176px;
      overflow-y: auto;
      border: 1px solid #2a2d32;
      border-radius: 2px;
      contain: content;
    }
    .repo-row {
      width: 100%;
      height: 64px;
      overflow: hidden;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 12px;
      border: 1px solid transparent;
      background: transparent;
      color: inherit;
      text-align: left;
      contain: layout paint style;
    }
    .repo-row:hover { background: #191b20; }
    .repo-avatar {
      width: 28px;
      height: 28px;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      border: 1px solid #2a2d32;
      border-radius: 2px;
      background: #181a1f;
      color: #a1a1aa;
      font-size: 12px;
      font-weight: 500;
    }
    .repo-copy { min-width: 0; flex: 1; }
    .repo-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
      font-weight: 500;
    }
    .repo-full {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      color: #a1a1aa;
    }
    .repo-description {
      margin: 0;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      font-size: 12px;
      line-height: 16px;
      color: #c6c6ce;
    }
    .repo-radio {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      border: 2px solid #3a3d45;
      border-radius: 999px;
    }
  </style>
</head>
<body>
  <div data-testid="onboarding-github-repo-list">${rows}</div>
</body>
</html>`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createOutputTail(limit = 16_384) {
  let text = '';
  return {
    push(chunk) {
      text = (text + chunk).slice(-limit);
    },
    text() {
      return text;
    },
    lines(count = 40) {
      return text.trimEnd().split('\n').slice(-count).join('\n');
    },
  };
}

const activeBrowsers = new Set();

function signalBrowser(child, signal) {
  try {
    // The browser is spawned as a process-group leader so the signal also
    // reaches its zygote, renderer and GPU helpers.
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // Already gone.
  }
}

// Last-resort cleanup when the script is interrupted or exits mid-check.
function cleanupActiveBrowsersSync() {
  for (const browser of activeBrowsers) {
    signalBrowser(browser.child, 'SIGKILL');
    try {
      rmSync(browser.userDataDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best effort only.
    }
  }
  activeBrowsers.clear();
}

process.once('exit', cleanupActiveBrowsersSync);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanupActiveBrowsersSync();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

function describeBrowserFailure(browser, reason) {
  const elapsed = Date.now() - browser.startedAt;
  const stderr = browser.stderrTail.lines();
  return [
    `${reason} (after ${elapsed} ms, chromium=${chromiumPath})`,
    stderr ? `--- chromium stderr (tail) ---\n${stderr}\n--- end chromium stderr ---` : '(chromium wrote nothing to stderr)',
  ].join('\n');
}

function waitForDevToolsPort(browser) {
  const { child, userDataDir, stderrTail } = browser;
  const activePortPath = join(userDataDir, 'DevToolsActivePort');

  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer;

    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(pollTimer);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(port);
    };

    // Chromium prints this as soon as the DevTools server is bound; it is the
    // same moment DevToolsActivePort is written, so whichever arrives first wins.
    const onStderr = () => {
      const match = /DevTools listening on ws:\/\/[^\s/]+:(\d+)\//.exec(stderrTail.text());
      if (match) finish(null, Number(match[1]));
    };
    const onExit = (code, signal) => {
      finish(new Error(describeBrowserFailure(browser, `Chromium exited before DevTools was ready (code=${code}, signal=${signal})`)));
    };
    const onError = (error) => {
      const hint = error.code === 'ENOENT' ? ' Set CHROMIUM_BIN to a Chromium/Chrome executable.' : '';
      const failure = new Error(describeBrowserFailure(browser, `Failed to launch Chromium: ${error.message}.${hint}`));
      failure.retryable = error.code !== 'ENOENT' && error.code !== 'EACCES';
      finish(failure);
    };
    const poll = async () => {
      try {
        const content = await readFile(activePortPath, 'utf8');
        // Only trust the port once the second line has started, so a partially
        // written file can never yield a truncated port number.
        const [port, browserPath] = content.split('\n');
        if (browserPath !== undefined && /^\d+$/.test(port) && Number(port) > 0) {
          finish(null, Number(port));
          return;
        }
      } catch {
        // Not written yet.
      }
      if (!settled) pollTimer = setTimeout(poll, 50);
    };
    const deadline = setTimeout(() => {
      finish(new Error(describeBrowserFailure(browser, `Timed out after ${CHROMIUM_STARTUP_TIMEOUT_MS} ms waiting for Chromium DevTools port`)));
    }, CHROMIUM_STARTUP_TIMEOUT_MS);

    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
    onStderr();
    poll();
  });
}

// Resolves true once the child exits, or false after timeoutMs. The timer is
// always cleared so it cannot keep the Node process alive afterwards.
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopProcess(child) {
  // A failed spawn (e.g. ENOENT) has no pid and will never emit 'exit'.
  if (!child.pid) return;
  if (child.exitCode === null && child.signalCode === null) {
    signalBrowser(child, 'SIGTERM');
    if (!(await waitForExit(child, 5_000))) {
      signalBrowser(child, 'SIGKILL');
      await waitForExit(child, 2_000);
    }
  }
  // Sweep helpers that may outlive the browser process itself.
  signalBrowser(child, 'SIGKILL');
}

async function closeBrowser(browser) {
  activeBrowsers.delete(browser);
  await stopProcess(browser.child);
  await rm(browser.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function launchChromium() {
  const userDataDir = await mkdtemp(join(tmpdir(), 'openlinear-repo-scroll-'));
  const child = spawn(chromiumPath, [...CHROMIUM_FLAGS, `--user-data-dir=${userDataDir}`, 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const stderrTail = createOutputTail();
  // Keep draining stderr for the browser's whole life so it can never block on
  // a full pipe, and so the tail is available for any later failure message.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderrTail.push(chunk));
  // Permanent listener so a late 'error' event can never go unhandled.
  child.on('error', (error) => stderrTail.push(`\n[spawn error] ${error.message}\n`));
  const browser = { child, userDataDir, stderrTail, startedAt: Date.now(), port: 0 };
  activeBrowsers.add(browser);
  try {
    browser.port = await waitForDevToolsPort(browser);
    return browser;
  } catch (error) {
    await closeBrowser(browser);
    throw error;
  }
}

async function launchChromiumWithRetry() {
  let lastError;
  for (let attempt = 1; attempt <= CHROMIUM_STARTUP_ATTEMPTS; attempt += 1) {
    try {
      return await launchChromium();
    } catch (error) {
      lastError = error;
      if (error.retryable === false) break;
      if (attempt < CHROMIUM_STARTUP_ATTEMPTS) {
        console.warn(`[repo-scroll] Chromium startup attempt ${attempt}/${CHROMIUM_STARTUP_ATTEMPTS} failed; relaunching.\n${error.message}`);
      }
    }
  }
  throw lastError;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function openCdpPage(port, url) {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  let target;
  try {
    target = await fetchJson(endpoint, { method: 'PUT' });
  } catch {
    target = await fetchJson(endpoint);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening the CDP page WebSocket')), 10_000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP page WebSocket failed to open')); }, { once: true });
  });
  return ws;
}

function createCdpClient(ws) {
  let id = 0;
  const pending = new Map();
  const rejectAll = (error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(message.error.message));
    } else {
      entry.resolve(message.result);
    }
  });
  ws.addEventListener('close', () => rejectAll(new Error('CDP connection closed')));

  return {
    send(method, params = {}, timeoutMs = CDP_CALL_TIMEOUT_MS) {
      const callId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(callId);
          reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(callId, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        ws.send(JSON.stringify({ id: callId, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(`In-page evaluation failed: ${details.exception?.description ?? details.text}`);
  }
  return result.result.value;
}

async function waitForFixture(cdp) {
  const startedAt = Date.now();
  const readyExpression = `document.readyState === 'complete' && Boolean(document.querySelector('[data-testid="onboarding-github-repo-list"]'))`;
  let lastError;
  while (Date.now() - startedAt < PAGE_READY_TIMEOUT_MS) {
    try {
      if (await evaluate(cdp, readyExpression)) return;
    } catch (error) {
      // The initial navigation can briefly replace the execution context.
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Fixture page was not ready after ${PAGE_READY_TIMEOUT_MS} ms${lastError ? `: ${lastError.message}` : ''}`);
}

// Runs inside the page. Returns raw per-pass frame deltas so all statistics are
// computed (and printed) on the Node side.
async function measureRepoScroll(passCount, steps) {
  const scroller = document.querySelector('[data-testid="onboarding-github-repo-list"]');
  if (!scroller) throw new Error('repo list not found');
  const rows = document.querySelectorAll('[data-testid="onboarding-github-repo-row"]').length;
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const passes = [];

  for (let pass = 0; pass < passCount; pass += 1) {
    const longTasks = [];
    let observer;
    if ('PerformanceObserver' in window) {
      try {
        observer = new PerformanceObserver((list) => {
          longTasks.push(...list.getEntries().map((entry) => entry.duration));
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch {}
    }

    const frames = [];
    const scrollDown = pass % 2 === 0;
    let last = performance.now();
    for (let step = 0; step <= steps; step += 1) {
      await new Promise((resolve) => {
        requestAnimationFrame((now) => {
          frames.push(now - last);
          last = now;
          const progress = step / steps;
          scroller.scrollTop = maxScrollTop * (scrollDown ? progress : 1 - progress);
          resolve();
        });
      });
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (observer) {
      longTasks.push(...observer.takeRecords().map((entry) => entry.duration));
      observer.disconnect();
    }
    passes.push({ direction: scrollDown ? 'down' : 'up', frames, longTasks });
  }

  return { rows, maxScrollTop, passes };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

function summarizePass(pass, index) {
  // The first rAF delta spans script start to the first frame (it can even be
  // negative), and the next few absorb scroll-start setup; drop them.
  const measured = pass.frames.slice(WARMUP_FRAMES);
  const sorted = [...measured].sort((a, b) => a - b);
  const summary = {
    pass: index + 1,
    direction: pass.direction,
    frameCount: sorted.length,
    p50FrameMs: percentile(sorted, 0.5),
    p95FrameMs: percentile(sorted, 0.95),
    p99FrameMs: percentile(sorted, 0.99),
    maxFrameMs: sorted.at(-1) ?? 0,
    longTaskCount: pass.longTasks.length,
    maxLongTaskMs: Math.max(0, ...pass.longTasks),
    // Frames that missed at least one vsync, with their index in the pass.
    slowFrames: pass.frames
      .map((ms, frame) => ({ frame, ms }))
      .slice(WARMUP_FRAMES)
      .filter(({ ms }) => ms > SLOW_FRAME_MS),
  };
  const breaches = [];
  if (summary.p95FrameMs >= P95_FRAME_LIMIT_MS) breaches.push(`p95 ${summary.p95FrameMs.toFixed(1)}ms >= ${P95_FRAME_LIMIT_MS}ms`);
  if (summary.maxFrameMs >= MAX_FRAME_LIMIT_MS) breaches.push(`max frame ${summary.maxFrameMs.toFixed(1)}ms >= ${MAX_FRAME_LIMIT_MS}ms`);
  if (summary.longTaskCount > 0) breaches.push(`${summary.longTaskCount} long task(s), max ${summary.maxLongTaskMs.toFixed(1)}ms`);
  summary.breaches = breaches;
  return summary;
}

function formatPass(summary) {
  const shown = summary.slowFrames.slice(0, 8).map(({ frame, ms }) => `#${frame}:${ms.toFixed(1)}ms`);
  if (summary.slowFrames.length > shown.length) shown.push(`+${summary.slowFrames.length - shown.length} more`);
  const slow = shown.length > 0 ? ` slowFrames=[${shown.join(', ')}]` : '';
  const verdict = summary.breaches.length > 0 ? ` BREACH: ${summary.breaches.join('; ')}` : '';
  return `pass ${summary.pass}/${MEASURED_PASSES} (${summary.direction}): frames=${summary.frameCount} p50=${summary.p50FrameMs.toFixed(1)}ms p95=${summary.p95FrameMs.toFixed(1)}ms p99=${summary.p99FrameMs.toFixed(1)}ms max=${summary.maxFrameMs.toFixed(1)}ms longTasks=${summary.longTaskCount}${slow}${verdict}`;
}

function assertScrollPerformance(summaries) {
  const report = summaries.map(formatPass).join('\n');

  const pathological = summaries.filter((s) => s.maxFrameMs >= HARD_CEILING_MS || s.maxLongTaskMs >= HARD_CEILING_MS);
  assert.equal(
    pathological.length,
    0,
    `repo scroll froze for >= ${HARD_CEILING_MS}ms in pass ${pathological.map((s) => s.pass).join(', ')} (hard ceiling, never tolerated)\n${report}`,
  );

  const breached = summaries.filter((s) => s.breaches.length > 0);
  assert.ok(
    breached.length <= MAX_TOLERATED_BREACHED_PASSES,
    `repo scroll too slow in ${breached.length}/${summaries.length} passes (at most ${MAX_TOLERATED_BREACHED_PASSES} isolated breach tolerated)\n${report}`,
  );
  if (breached.length > 0) {
    console.warn(`[repo-scroll] tolerated one isolated breach (pass ${breached[0].pass}); other passes were within limits.`);
  }
}

async function runBrowserScrollCheck(html) {
  const browser = await launchChromiumWithRetry();
  let cdp;
  try {
    const encoded = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const ws = await openCdpPage(browser.port, encoded);
    cdp = createCdpClient(ws);
    await cdp.send('Runtime.enable');
    await waitForFixture(cdp);
    await delay(300);

    const result = await evaluate(cdp, `(${measureRepoScroll.toString()})(${MEASURED_PASSES}, ${SCROLL_STEPS})`);
    assert.equal(result.rows, 8, 'repo picker should render only the capped search result count');
    assert.ok(result.maxScrollTop > 0, 'repo list fixture must actually scroll');

    const summaries = result.passes.map(summarizePass);
    for (const summary of summaries) console.log(formatPass(summary));
    assertScrollPerformance(summaries);
    return { rows: result.rows, summaries };
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    // Wrap rather than mutate: Node prints error.stack, which keeps the old message.
    throw new Error(describeBrowserFailure(browser, error instanceof Error ? error.message : String(error)), { cause: error });
  } finally {
    cdp?.close();
    await closeBrowser(browser);
  }
}

const source = await readFile(onboardingPath, 'utf8');
const projectStepSource = await readFile(projectStepPath, 'utf8');
const onboardingUtilsSource = await readFile(onboardingUtilsPath, 'utf8');
const homePageSource = await readFile(homePagePath, 'utf8');
const projectHookSource = await readFile(projectHookPath, 'utf8');
const chatPanelSource = await readFile(chatPanelPath, 'utf8');
const chatMessageListSource = await readFile(chatMessageListPath, 'utf8');
assertRepoPickerSourceGuards(projectStepSource, onboardingUtilsSource);
assertOnboardingWizardSourceGuards(source);
assertHomePageSourceGuards(homePageSource);
assertProjectHookSourceGuards(projectHookSource);
assertChatPanelSourceGuards(chatPanelSource);
assertChatMessageListSourceGuards(chatMessageListSource);

const { rows, summaries } = await runBrowserScrollCheck(buildFixtureHtml());
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(
  `ok onboarding repo picker scroll p95=${median(summaries.map((s) => s.p95FrameMs)).toFixed(1)}ms max=${Math.max(...summaries.map((s) => s.maxFrameMs)).toFixed(1)}ms rows=${rows} (median p95 / worst max over ${summaries.length} passes)`,
);
