#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const onboardingPath = new URL('../apps/desktop-ui/components/onboarding/onboarding-wizard.tsx', import.meta.url);
const homePagePath = new URL('../apps/desktop-ui/app/(app)/page.tsx', import.meta.url);
const projectHookPath = new URL('../apps/desktop-ui/hooks/use-project.tsx', import.meta.url);
const chatMessageListPath = new URL('../apps/desktop-ui/components/chat/chat-message-list.tsx', import.meta.url);
const chromiumPath = process.env.CHROMIUM_BIN || '/usr/bin/chromium';

function assertSourceGuards(source) {
  const repoItemStart = source.indexOf('const RepoItem = memo(function RepoItem');
  const repoListStart = source.indexOf('const GitHubRepoList = memo(function GitHubRepoList');
  assert.notEqual(repoItemStart, -1, 'RepoItem component not found');
  assert.notEqual(repoListStart, -1, 'GitHubRepoList component not found');

  const repoItemSource = source.slice(repoItemStart, repoListStart);
  const repoListSource = source.slice(repoListStart, source.indexOf('// ─── Step 2'));

  assert.equal(source.includes('useVirtualizer'), false, 'onboarding repo picker must not use scroll virtualization');
  assert.equal(source.includes('fetchGitHubBranches'), false, 'repo selection must not trigger automatic branch-list fetches');
  assert.equal(source.includes('Load more'), false, 'onboarding repo picker must not use paged browse/load-more');
  assert.match(source, /const REPO_SEARCH_LIMIT = ([1-9]|1[0-2])\b/, 'repo search limit must stay at or below 12');
  assert.match(repoListSource, /q: repoQuery/, 'repo fetches must be query-driven');
  assert.match(repoListSource, /!repoQuery[\s\S]*setRepos\(\[\]\)/, 'empty search must clear repos without fetching');
  assert.match(repoListSource, /data-testid="onboarding-github-repo-list"/, 'repo list test id missing');
  assert.match(repoItemSource, /data-testid="onboarding-github-repo-row"/, 'repo row test id missing');
  assert.match(repoItemSource, /<img[\s\S]*loading="lazy"[\s\S]*decoding="async"/, 'repo logos must be lazy and async decoded');
  assert.match(repoItemSource, /onError=\{\(event\) => event\.currentTarget\.remove\(\)\}/, 'repo logos need a cheap failure fallback');
  assert.match(source, /initialWorkspaceId\?: string \| null/, 'wizard must accept an existing workspace id');
  assert.match(source, /initialProjectId\?: string \| null/, 'wizard must accept an existing project id for team setup');
  assert.match(source, /const workspaceIdForProject = createdWorkspaceId \?\? initialWorkspaceId/, 'project creation must fall back to the initial workspace id');
  assert.match(source, /setCurrentStep\(initialProjectId \? 2 : 1\)/, 'existing project onboarding must start at team setup');
  assert.match(source, /if \(initialProjectId && createdProjectId === initialProjectId\)/, 'existing project back path must not create duplicate projects');
  assert.match(source, /isExistingProject=\{Boolean\(initialProjectId && createdProjectId === initialProjectId\)\}/, 'existing project step must render read-only project UI');
  assert.match(source, /onBack=\{\(\) => setCurrentStep\(1\)\}/, 'team setup must expose a back button');
  assert.match(source, /createdWorkspaceId, createdProjectId/, 'stored drafts must keep created ids needed by later steps');
  assert.match(source, /className="max-h-44 overflow-y-auto/, 'repo list height should stay compact inside the card');
}

function assertHomePageSourceGuards(source) {
  const wizardIndex = source.indexOf('<OnboardingWizard');
  assert.notEqual(wizardIndex, -1, 'home page onboarding render not found');
  const onboardingWrapperSource = source.slice(Math.max(0, wizardIndex - 250), wizardIndex + 350);
  assert.match(onboardingWrapperSource, /overflow-hidden/, 'onboarding page wrapper must hide page-level overflow');
  assert.equal(onboardingWrapperSource.includes('overflow-y-auto'), false, 'onboarding page wrapper must not use page-level vertical scrolling');
  assert.match(onboardingWrapperSource, /initialWorkspaceId=\{onboardingWorkspaceId\}/, 'home page must pass the existing workspace id into onboarding');
  assert.match(source, /projectWithoutTeam/, 'home page must keep onboarding active for teamless projects');
  assert.match(onboardingWrapperSource, /initialProjectId=\{projectWithoutTeam\?\.id \?\? null\}/, 'home page must pass a teamless project id into onboarding');
  assert.match(onboardingWrapperSource, /initialProjectName=\{projectWithoutTeam\?\.name \?\? null\}/, 'home page must pass a teamless project name into onboarding');
  assert.match(source, /const isThinking = isStreaming && !streamingContent && activeToolCalls\.length === 0/, 'home page must compute an empty-response thinking state');
  assert.match(source, /isThinking=\{isThinking\}/, 'home page must pass thinking state to chat message list');
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

async function waitForDevToolsPort(userDataDir, child) {
  const activePortPath = join(userDataDir, 'DevToolsActivePort');
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`Chromium exited early with code ${child.exitCode}`);
    }
    try {
      const content = await readFile(activePortPath, 'utf8');
      const [port] = content.trim().split('\n');
      if (port) return Number(port);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Chromium DevTools port');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function openCdpPage(port, url) {
  let target;
  try {
    target = await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  } catch {
    target = await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return ws;
}

function createCdpClient(ws) {
  let id = 0;
  const pending = new Map();
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

  return {
    send(method, params = {}) {
      const callId = ++id;
      ws.send(JSON.stringify({ id: callId, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(callId, { resolve, reject });
      });
    },
    close() {
      ws.close();
    },
  };
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function runBrowserScrollCheck(html) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'openlinear-repo-scroll-'));
  const child = spawn(chromiumPath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const port = await waitForDevToolsPort(userDataDir, child);
    const encoded = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const ws = await openCdpPage(port, encoded);
    const cdp = createCdpClient(ws);
    await cdp.send('Runtime.enable');
    await new Promise((resolve) => setTimeout(resolve, 300));

    const result = await cdp.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(${async function measureRepoScroll() {
        const scroller = document.querySelector('[data-testid="onboarding-github-repo-list"]');
        if (!scroller) throw new Error('repo list not found');
        const rows = document.querySelectorAll('[data-testid="onboarding-github-repo-row"]').length;
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
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        let last = performance.now();
        for (let step = 0; step <= 120; step += 1) {
          await new Promise((resolve) => {
            requestAnimationFrame((now) => {
              frames.push(now - last);
              last = now;
              scroller.scrollTop = maxScrollTop * (step / 120);
              resolve();
            });
          });
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
        observer?.disconnect();

        const sampled = frames.slice(5).sort((a, b) => a - b);
        const p95 = sampled[Math.floor(sampled.length * 0.95)] ?? 0;
        const max = sampled.at(-1) ?? 0;
        return {
          rows,
          frameCount: sampled.length,
          p95FrameMs: p95,
          maxFrameMs: max,
          longTaskCount: longTasks.length,
          maxLongTaskMs: Math.max(0, ...longTasks),
        };
      }})()`,
    });

    cdp.close();
    const metrics = result.result.value;
    assert.equal(metrics.rows, 8, 'repo picker should render only the capped search result count');
    assert.ok(metrics.p95FrameMs < 40, `repo scroll p95 frame too slow: ${metrics.p95FrameMs.toFixed(1)}ms`);
    assert.ok(metrics.maxFrameMs < 120, `repo scroll max frame too slow: ${metrics.maxFrameMs.toFixed(1)}ms`);
    assert.ok(metrics.longTaskCount === 0, `repo scroll produced long tasks: ${JSON.stringify(metrics)}`);
    return metrics;
  } finally {
    await stopProcess(child);
    await rm(userDataDir, { recursive: true, force: true });
  }
}

const source = await readFile(onboardingPath, 'utf8');
const homePageSource = await readFile(homePagePath, 'utf8');
const projectHookSource = await readFile(projectHookPath, 'utf8');
const chatMessageListSource = await readFile(chatMessageListPath, 'utf8');
assertSourceGuards(source);
assertHomePageSourceGuards(homePageSource);
assertProjectHookSourceGuards(projectHookSource);
assertChatMessageListSourceGuards(chatMessageListSource);

const metrics = await runBrowserScrollCheck(buildFixtureHtml());
console.log(
  `ok onboarding repo picker scroll p95=${metrics.p95FrameMs.toFixed(1)}ms max=${metrics.maxFrameMs.toFixed(1)}ms rows=${metrics.rows}`,
);
