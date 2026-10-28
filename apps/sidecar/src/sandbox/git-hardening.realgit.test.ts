import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHardenedGitArgs, execGit, execGitWithCredentials, HARDENED_GIT_ENV } from '../services/git-credentials';
import { buildHardenedGitEnv, GitConfigPolicyError } from './git-hardening';

/**
 * Real-git regression corpus for the sidecar's own git invocations in
 * agent-controlled worktrees. Every payload writes a marker file when it
 * executes. For each payload we show:
 *   - plain git (isolated from the real user config): the payload executes,
 *     proving the fixture is a live trigger;
 *   - the pre-W09a hardening (hooksPath/fsmonitor/pager/protocol only): the
 *     outcome is recorded — several payloads still executed;
 *   - the W09a hardened entry points (execGit / execGitWithCredentials):
 *     the payload never executes (the config scan refuses to run git, and the
 *     `-c`/env layer alone is also checked for the fixed-name keys).
 * Only fixture repositories under a fresh temp dir are touched; HOME is a
 * fabricated directory.
 */

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const describeGit = gitAvailable ? describe : describe.skip;

const PRE_W09A_ARGS = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=',
  '-c', 'core.pager=cat',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
];

let root = '';
let fakeHome = '';
const outcomes: Array<{ payload: string; plain: boolean; preW09a: boolean | 'n/a'; hardened: boolean; blockedBy: string }> = [];

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: fakeHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
}

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync('git', ['-C', cwd, ...args], { env: { ...baseEnv(), ...extraEnv }, encoding: 'utf8' });
}

/** Runs git with arbitrary args/env, never throwing; returns the exit status. */
function tryGit(cwd: string, prefix: string[], args: string[], env: Record<string, string>, input?: string): number | null {
  return spawnSync('git', [...prefix, '-C', cwd, ...args], { env, input, encoding: 'utf8', timeout: 20_000 }).status;
}

function payloadScript(name: string, body = ''): { script: string; marker: string } {
  const marker = join(root, 'markers', `${name}.ran`);
  const script = join(root, 'payloads', `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\necho executed >> '${marker}'\n${body}\n`);
  chmodSync(script, 0o755);
  return { script, marker };
}

let repoCounter = 0;
/** A fresh repo with one commit; returns its path. */
function freshRepo(files: Record<string, string> = { 'file.txt': 'one\n' }): string {
  repoCounter += 1;
  const repo = join(root, `repo-${repoCounter}`);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: baseEnv() });
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

function ran(marker: string): boolean {
  return existsSync(marker);
}

function reset(marker: string): void {
  rmSync(marker, { force: true });
}

const plainEnv = () => baseEnv();
const preW09aEnv = () => ({ ...baseEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });

/** Asserts the hardened entry point refuses (config scan) and nothing ran. */
async function expectHardenedRefusal(run: () => Promise<unknown>, marker: string): Promise<void> {
  await expect(run()).rejects.toBeInstanceOf(GitConfigPolicyError);
  expect(ran(marker)).toBe(false);
}

describeGit('git hardening against planted repository payloads (real git)', () => {
  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-git-payloads-')));
    fakeHome = join(root, 'home');
    for (const dir of ['home', 'markers', 'payloads']) mkdirSync(join(root, dir), { recursive: true });
  });

  afterAll(() => {
    // Printed so the ledger can quote the observed matrix.
    console.info(`[git-hardening corpus]\n${outcomes.map((o) => `${o.payload}: plain=${o.plain ? 'EXECUTED' : 'no'} preW09a=${o.preW09a === 'n/a' ? 'n/a' : o.preW09a ? 'EXECUTED' : 'no'} hardened=${o.hardened ? 'EXECUTED' : 'no'} (${o.blockedBy})`).join('\n')}`);
    rmSync(root, { recursive: true, force: true });
  });

  it('hook in the repository hooks dir (commit)', async () => {
    const repo = freshRepo();
    const { script, marker } = payloadScript('hook-pre-commit');
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), readFileSync(script));
    chmodSync(join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
    writeFileSync(join(repo, 'file.txt'), 'two\n');
    git(repo, ['add', '-A']);
    tryGit(repo, [], ['commit', '-q', '-m', 'plain'], plainEnv());
    const plain = ran(marker);
    reset(marker);
    writeFileSync(join(repo, 'file.txt'), 'three\n');
    git(repo, ['add', '-A']);
    tryGit(repo, PRE_W09A_ARGS, ['commit', '-q', '-m', 'old'], preW09aEnv());
    const preW09a = ran(marker);
    writeFileSync(join(repo, 'file.txt'), 'four\n');
    git(repo, ['add', '-A']);
    await execGit(['-C', repo, 'commit', '-q', '-m', 'hardened'], { env: baseEnv() });
    outcomes.push({ payload: 'hooks/pre-commit', plain, preW09a, hardened: ran(marker), blockedBy: 'core.hooksPath=/dev/null' });
    expect(plain).toBe(true);
    expect(ran(marker)).toBe(false);
  });

  it('core.fsmonitor (status)', async () => {
    const repo = freshRepo();
    const { script, marker } = payloadScript('fsmonitor');
    git(repo, ['config', 'core.fsmonitor', script]);
    tryGit(repo, [], ['status', '--porcelain'], plainEnv());
    const plain = ran(marker);
    reset(marker);
    tryGit(repo, PRE_W09A_ARGS, ['status', '--porcelain'], preW09aEnv());
    const preW09a = ran(marker);
    reset(marker);
    // -c/env layer alone (no scan):
    tryGit(repo, buildHardenedGitArgs([]), ['status', '--porcelain'], buildHardenedGitEnv(baseEnv()));
    const layer = ran(marker);
    await expectHardenedRefusal(() => execGit(['-C', repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all']), marker);
    outcomes.push({ payload: 'core.fsmonitor', plain, preW09a, hardened: layer, blockedBy: 'config scan + core.fsmonitor=false' });
    expect(plain).toBe(true);
    expect(layer).toBe(false);
  });

  it('filter.<driver>.clean via .gitattributes (add -A)', async () => {
    const repo = freshRepo();
    const { script, marker } = payloadScript('filter-clean', 'cat');
    git(repo, ['config', 'filter.evil.clean', script]);
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil\n');
    writeFileSync(join(repo, 'file.txt'), 'changed\n');
    tryGit(repo, [], ['add', '-A'], plainEnv());
    const plain = ran(marker);
    reset(marker);
    git(repo, ['reset', '-q']);
    writeFileSync(join(repo, 'file.txt'), 'changed again\n');
    tryGit(repo, PRE_W09A_ARGS, ['add', '-A'], preW09aEnv());
    const preW09a = ran(marker);
    reset(marker);
    await expectHardenedRefusal(() => execGit(['-C', repo, 'add', '-A', '--', '.']), marker);
    outcomes.push({ payload: 'filter.<x>.clean', plain, preW09a, hardened: false, blockedBy: 'config scan' });
    expect(plain).toBe(true);
    expect(preW09a).toBe(true);
  });

  it('filter.<driver>.process via .gitattributes (add -A)', async () => {
    const repo = freshRepo();
    const { script, marker } = payloadScript('filter-process', 'exit 1');
    git(repo, ['config', 'filter.evil.process', script]);
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil\n');
    writeFileSync(join(repo, 'file.txt'), 'changed\n');
    tryGit(repo, PRE_W09A_ARGS, ['add', '-A'], preW09aEnv());
    const preW09a = ran(marker);
    reset(marker);
    await expectHardenedRefusal(() => execGit(['-C', repo, 'add', '-A', '--', '.']), marker);
    outcomes.push({ payload: 'filter.<x>.process', plain: preW09a, preW09a, hardened: false, blockedBy: 'config scan' });
    expect(preW09a).toBe(true);
  });

  it('diff.<driver>.textconv, diff.<driver>.command and diff.external (diff)', async () => {
    for (const [name, key, attribute] of [
      ['textconv', 'diff.evil.textconv', '*.txt diff=evil\n'],
      ['diff-command', 'diff.evil.command', '*.txt diff=evil\n'],
      ['diff-external', 'diff.external', ''],
    ] as const) {
      const repo = freshRepo();
      const { script, marker } = payloadScript(name, name === 'textconv' ? 'cat "$1"' : '');
      git(repo, ['config', key, script]);
      if (attribute) writeFileSync(join(repo, '.gitattributes'), attribute);
      writeFileSync(join(repo, 'file.txt'), 'changed\n');
      tryGit(repo, PRE_W09A_ARGS, ['diff', 'HEAD'], preW09aEnv());
      const preW09a = ran(marker);
      reset(marker);
      if (name === 'diff-external') {
        tryGit(repo, buildHardenedGitArgs([]), ['diff', 'HEAD'], buildHardenedGitEnv(baseEnv()));
        expect(ran(marker)).toBe(false);
      }
      await expectHardenedRefusal(() => execGit(['-C', repo, 'diff', 'HEAD']), marker);
      outcomes.push({ payload: key, plain: preW09a, preW09a, hardened: false, blockedBy: name === 'diff-external' ? 'config scan + diff.external=' : 'config scan' });
      expect(preW09a).toBe(true);
    }
  });

  it('merge.<driver>.driver via .gitattributes (merge)', async () => {
    const repo = freshRepo({ 'file.txt': 'base\n', '.gitattributes': '*.txt merge=evil\n' });
    const { script, marker } = payloadScript('merge-driver', 'exit 0');
    git(repo, ['config', 'merge.evil.driver', `${script} %O %A %B`]);
    git(repo, ['checkout', '-q', '-b', 'task']);
    writeFileSync(join(repo, 'file.txt'), 'task side\n');
    git(repo, ['commit', '-q', '-am', 'task']);
    git(repo, ['checkout', '-q', 'main']);
    writeFileSync(join(repo, 'file.txt'), 'main side\n');
    git(repo, ['commit', '-q', '-am', 'main']);
    tryGit(repo, PRE_W09A_ARGS, ['merge', '--no-ff', '-m', 'Merge task', '--', 'task'], preW09aEnv());
    const preW09a = ran(marker);
    reset(marker);
    tryGit(repo, [], ['merge', '--abort'], plainEnv());
    git(repo, ['reset', '-q', '--hard', 'main']);
    await expectHardenedRefusal(() => execGit(['-C', repo, 'merge', '--no-ff', '-m', 'Merge task', '--', 'task'], { env: baseEnv() }), marker);
    outcomes.push({ payload: 'merge.<x>.driver', plain: preW09a, preW09a, hardened: false, blockedBy: 'config scan' });
    expect(preW09a).toBe(true);
  });

  it('credential helpers planted in repository config (credential fill = the push/fetch helper path)', async () => {
    const repo = freshRepo();
    const generic = payloadScript('credential-helper', 'echo username=x; echo password=y');
    const scoped = payloadScript('credential-helper-url', 'echo username=x; echo password=y');
    git(repo, ['config', 'credential.helper', `!${generic.script}`]);
    git(repo, ['config', 'credential.https://github.com.helper', `!${scoped.script}`]);
    const input = 'protocol=https\nhost=github.com\npath=acme/repo.git\n\n';
    const ours = ['-c', `credential.helper=store --file=${join(root, 'store')}`];
    tryGit(repo, [...PRE_W09A_ARGS, ...ours], ['credential', 'fill'], preW09aEnv(), input);
    const preW09a = ran(generic.marker) || ran(scoped.marker);
    reset(generic.marker);
    reset(scoped.marker);
    // -c/env layer alone: inherited helpers are reset before ours.
    tryGit(repo, [...buildHardenedGitArgs([]), ...ours], ['credential', 'fill'], buildHardenedGitEnv(baseEnv()), input);
    const layer = ran(generic.marker) || ran(scoped.marker);
    await expectHardenedRefusal(() => execGitWithCredentials(['-C', repo, 'status'], 'fake-token', 'https://github.com/acme/repo.git'), generic.marker);
    expect(ran(scoped.marker)).toBe(false);
    outcomes.push({ payload: 'credential.helper / credential.<url>.helper', plain: preW09a, preW09a, hardened: layer, blockedBy: 'config scan + credential.helper= reset' });
    expect(preW09a).toBe(true);
    expect(layer).toBe(false);
  });

  it('core.askPass (credential prompt path)', async () => {
    const repo = freshRepo();
    const { script, marker } = payloadScript('askpass', 'echo x');
    git(repo, ['config', 'core.askPass', script]);
    const input = 'protocol=https\nhost=github.com\n\n';
    tryGit(repo, PRE_W09A_ARGS, ['credential', 'fill'], preW09aEnv(), input);
    const preW09a = ran(marker);
    reset(marker);
    tryGit(repo, buildHardenedGitArgs([]), ['credential', 'fill'], buildHardenedGitEnv(baseEnv()), input);
    const layer = ran(marker);
    await expectHardenedRefusal(() => execGit(['-C', repo, 'status']), marker);
    outcomes.push({ payload: 'core.askPass', plain: preW09a, preW09a, hardened: layer, blockedBy: 'config scan + GIT_ASKPASS' });
    expect(preW09a).toBe(true);
    expect(layer).toBe(false);
  });

  it('gpg.program with commit.gpgSign (commit)', async () => {
    const repo = freshRepo();
    const { script, marker } = payloadScript('gpg');
    git(repo, ['config', 'gpg.program', script]);
    git(repo, ['config', 'commit.gpgSign', 'true']);
    writeFileSync(join(repo, 'file.txt'), 'two\n');
    git(repo, ['add', '-A']);
    tryGit(repo, PRE_W09A_ARGS, ['commit', '-q', '-m', 'old'], preW09aEnv());
    const preW09a = ran(marker);
    reset(marker);
    tryGit(repo, buildHardenedGitArgs([]), ['commit', '-q', '-m', 'layer'], buildHardenedGitEnv(baseEnv()));
    const layer = ran(marker);
    await expectHardenedRefusal(() => execGit(['-C', repo, 'commit', '-q', '-m', 'hardened'], { env: baseEnv() }), marker);
    outcomes.push({ payload: 'gpg.program + commit.gpgSign', plain: preW09a, preW09a, hardened: layer, blockedBy: 'config scan + commit.gpgSign=false + gpg.program=false' });
    expect(preW09a).toBe(true);
    expect(layer).toBe(false);
  });

  it('include.path / includeIf pulling in an executable filter (add -A)', async () => {
    for (const key of ['include.path', 'includeIf.gitdir:/.path']) {
      const repo = freshRepo();
      const { script, marker } = payloadScript(`include-${key.length}`, 'cat');
      const included = join(root, 'payloads', `included-${key.length}.cfg`);
      writeFileSync(included, `[filter "evil"]\n\tclean = ${script}\n`);
      git(repo, ['config', key, included]);
      writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil\n');
      writeFileSync(join(repo, 'file.txt'), 'changed\n');
      tryGit(repo, PRE_W09A_ARGS, ['add', '-A'], preW09aEnv());
      const preW09a = ran(marker);
      reset(marker);
      await expectHardenedRefusal(() => execGit(['-C', repo, 'add', '-A', '--', '.']), marker);
      outcomes.push({ payload: key, plain: preW09a, preW09a, hardened: false, blockedBy: 'config scan' });
      expect(preW09a).toBe(true);
    }
  });

  it('core.sshCommand and remote.<name>.uploadpack (fetch)', async () => {
    const source = freshRepo();
    const ssh = payloadScript('ssh-command', 'exit 1');
    const repoSsh = freshRepo();
    git(repoSsh, ['config', 'core.sshCommand', ssh.script]);
    tryGit(repoSsh, [], ['fetch', 'ssh://example.invalid/repo.git'], plainEnv());
    const plainSsh = ran(ssh.marker);
    reset(ssh.marker);
    tryGit(repoSsh, buildHardenedGitArgs([]), ['fetch', 'ssh://example.invalid/repo.git'], buildHardenedGitEnv(baseEnv()));
    const layerSsh = ran(ssh.marker);
    await expectHardenedRefusal(() => execGit(['-C', repoSsh, 'fetch', 'ssh://example.invalid/repo.git']), ssh.marker);
    outcomes.push({ payload: 'core.sshCommand', plain: plainSsh, preW09a: 'n/a', hardened: layerSsh, blockedBy: 'config scan + https-only protocol + core.sshCommand=false' });
    expect(plainSsh).toBe(true);
    expect(layerSsh).toBe(false);

    const upload = payloadScript('uploadpack', 'exit 1');
    const repoUpload = freshRepo();
    git(repoUpload, ['remote', 'add', 'origin', source]);
    git(repoUpload, ['config', 'remote.origin.uploadpack', upload.script]);
    tryGit(repoUpload, [], ['fetch', 'origin'], plainEnv());
    const plainUpload = ran(upload.marker);
    reset(upload.marker);
    await expectHardenedRefusal(() => execGit(['-C', repoUpload, 'fetch', 'origin']), upload.marker);
    outcomes.push({ payload: 'remote.<name>.uploadpack', plain: plainUpload, preW09a: 'n/a', hardened: false, blockedBy: 'config scan + https-only protocol' });
    expect(plainUpload).toBe(true);
  });

  it('refuses credential/destination redirection keys without running git', async () => {
    for (const [key, value] of [
      ['url.https://evil.example/.insteadOf', 'https://github.com/'],
      ['remote.origin.pushurl', 'https://evil.example/repo.git'],
      ['http.https://github.com/.proxy', 'http://127.0.0.1:9'],
      ['http.sslVerify', 'false'],
      ['core.worktree', '/'],
      ['core.hooksPath', '/tmp'],
      ['alias.st', '!touch /tmp/never'],
      ['submodule.x.update', '!touch /tmp/never'],
    ] as const) {
      const repo = freshRepo();
      git(repo, ['config', key, value]);
      await expect(execGit(['-C', repo, 'status'])).rejects.toMatchObject({ code: 'GIT_CONFIG_UNSAFE' });
    }
    outcomes.push({ payload: 'url.insteadOf / pushurl / http.<url>.* / core.worktree / alias / submodule.*', plain: false, preW09a: 'n/a', hardened: false, blockedBy: 'config scan (refused)' });
  });

  it('ignores replace refs planted to change what the sidecar reads', async () => {
    const repo = freshRepo({ 'file.txt': 'original\n' });
    const blob = git(repo, ['rev-parse', 'HEAD:file.txt']).trim();
    const fakeBlob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { env: baseEnv(), input: 'replaced\n', encoding: 'utf8' }).trim();
    git(repo, ['replace', blob, fakeBlob]);
    expect(git(repo, ['show', 'HEAD:file.txt'])).toBe('replaced\n');
    const { stdout } = await execGit(['-C', repo, 'show', 'HEAD:file.txt']);
    expect(stdout).toBe('original\n');
    outcomes.push({ payload: 'refs/replace/*', plain: true, preW09a: true, hardened: false, blockedBy: 'GIT_NO_REPLACE_OBJECTS=1' });
  });

  it('allows the sidecar flow on a clean repository and keeps secrets out of the git env', async () => {
    const repo = freshRepo();
    writeFileSync(join(repo, 'file.txt'), 'agent change\n');
    const secrets = { JWT_SECRET: 'fake-jwt-secret-value', TOKEN_ENCRYPTION_KEY: 'fake-encryption-key', DATABASE_URL: 'postgres://u:fake-pass@localhost/db', GITHUB_TOKEN: 'fake-ghp-token' };
    const envProbe = payloadScript('env-probe');
    // A legitimate repo has no filters, so probe the env with an allowed
    // mechanism: an inline -c alias is not used by the sidecar; instead spawn
    // `git var -l` through the hardened builders and inspect what git sees.
    const env = buildHardenedGitEnv({ ...process.env, ...secrets, GIT_AUTHOR_NAME: 'Agent' }, { ...process.env, ...secrets });
    const seen = spawnSync('git', [...buildHardenedGitArgs([]), '-C', repo, 'var', '-l'], { env, encoding: 'utf8' }).stdout;
    for (const value of Object.values(secrets)) expect(seen).not.toContain(value);
    for (const key of Object.keys(secrets)) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject({ GIT_AUTHOR_NAME: 'Agent', GIT_CONFIG_GLOBAL: '/dev/null', ...HARDENED_GIT_ENV });
    reset(envProbe.marker);
    await execGit(['-C', repo, 'add', '-A', '--', '.']);
    await execGit(['-C', repo, 'commit', '-q', '-m', 'agent'], { env: { ...process.env, ...secrets, GIT_AUTHOR_NAME: 'Agent', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'Agent', GIT_COMMITTER_EMAIL: 'a@example.invalid' } });
    expect(git(repo, ['log', '-1', '--format=%an %s'])).toBe('Agent agent\n');
  });
});
