// Tests for scripts/bump-version.js. Run: node --test scripts/bump-version.test.js
// Fixtures are copies of the real target files, so a format change in any of
// them (or a deleted target) fails here before it breaks a release.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const { planBump, applyPlan, incrementVersion, compareVersions, TARGETS } = require('./bump-version.js');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'bump-version.js');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-version-'));
  for (const { file } of TARGETS) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(REPO, file), path.join(root, file));
  }
  return root;
}

function snapshot(root) {
  return Object.fromEntries(
    TARGETS.map(({ file }) => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]),
  );
}

const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');

test('increments like npm, including finishing prereleases', () => {
  assert.equal(incrementVersion('0.1.61', 'patch'), '0.1.62');
  assert.equal(incrementVersion('0.1.61', 'minor'), '0.2.0');
  assert.equal(incrementVersion('0.1.61', 'major'), '1.0.0');
  assert.equal(incrementVersion('1.2.0-rc.1', 'patch'), '1.2.0');
  assert.equal(incrementVersion('1.2.0-rc.1', 'minor'), '1.2.0');
  assert.equal(incrementVersion('1.2.3-rc.1', 'minor'), '1.3.0');
  assert.equal(incrementVersion('2.0.0-rc.1', 'major'), '2.0.0');
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
});

test('every target exists in the repository and parses', () => {
  const plan = planBump({ arg: '99.0.0', tags: null });
  assert.deepEqual(
    plan.changes.map((c) => c.file),
    TARGETS.map((t) => t.file),
  );
});

test('patch bumps from the newest tag when the files lag behind, in every file', () => {
  const root = makeFixture();
  fs.writeFileSync(
    path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'),
    read(root, 'apps/desktop/src-tauri/tauri.conf.json').replace(/^( {2}"version":\s*)"[^"]*"/m, '$1"0.1.0"'),
  );
  const before = read(root, 'apps/desktop/src-tauri/tauri.conf.json');
  const plan = planBump({ arg: 'patch', root, tags: ['0.1.59', '0.1.61', '0.1.60', '0.2.0-beta.1'] });
  assert.equal(plan.base, '0.1.61');
  assert.equal(plan.next, '0.1.62');
  assert.ok(plan.notes.some((n) => n.includes('newest tag is v0.1.61')));
  applyPlan(plan);

  for (const file of ['apps/desktop/src-tauri/tauri.conf.json', 'apps/desktop/package.json', 'packages/openlinear-cli/package.json']) {
    assert.equal(JSON.parse(read(root, file)).version, '0.1.62', file);
  }
  // Only the version line changed in tauri.conf.json (formatting preserved).
  const after = read(root, 'apps/desktop/src-tauri/tauri.conf.json');
  const diff = after.split('\n').filter((line, i) => line !== before.split('\n')[i]);
  assert.deepEqual(diff, ['  "version": "0.1.62",']);

  const pkgbuild = read(root, 'packaging/aur/openlinear-bin/PKGBUILD');
  assert.match(pkgbuild, /^pkgver=0\.1\.62$/m);
  assert.match(pkgbuild, /^pkgrel=1$/m);
  const srcinfo = read(root, 'packaging/aur/openlinear-bin/.SRCINFO');
  assert.match(srcinfo, /^\s*pkgver = 0\.1\.62$/m);
  assert.match(srcinfo, /\/download\/v0\.1\.62\/openlinear-0\.1\.62-x86_64\.AppImage/);
  assert.match(srcinfo, /openlinear-0\.1\.62-x86_64\.AppImage::/);
  assert.match(srcinfo, /\/v0\.1\.62\/apps\/desktop/);
  assert.doesNotMatch(srcinfo, /0\.1\.0\b/);
  // No temp files left behind.
  assert.deepEqual(
    fs.readdirSync(path.join(root, 'packaging/aur/openlinear-bin')).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

test('refuses an existing or older version and writes nothing', () => {
  const root = makeFixture();
  const before = snapshot(root);
  assert.throws(() => planBump({ arg: '0.1.61', root, tags: ['0.1.61'] }), /tag v0\.1\.61 already exists/);
  assert.throws(() => planBump({ arg: '0.1.5', root, tags: ['0.1.61'] }), /not newer than the newest tag v0\.1\.61/);
  assert.throws(() => planBump({ arg: 'banana', root, tags: [] }), /invalid argument/);
  assert.deepEqual(snapshot(root), before);
});

test('a missing target fails before anything is written', () => {
  const root = makeFixture();
  fs.rmSync(path.join(root, 'packaging/aur/openlinear-bin/PKGBUILD'));
  const before = read(root, 'apps/desktop/src-tauri/tauri.conf.json');
  assert.throws(() => planBump({ arg: 'patch', root, tags: [] }), /PKGBUILD: cannot read \(ENOENT\).*update TARGETS/);
  assert.equal(read(root, 'apps/desktop/src-tauri/tauri.conf.json'), before);
});

test('a malformed target fails before anything is written', () => {
  const root = makeFixture();
  fs.writeFileSync(path.join(root, 'packaging/aur/openlinear-bin/.SRCINFO'), 'pkgbase = openlinear-bin\n');
  const before = snapshot(root);
  assert.throws(() => planBump({ arg: 'patch', root, tags: [] }), /\.SRCINFO: has no "pkgver =" line/);
  assert.deepEqual(snapshot(root), before);
});

test('prereleases update the JSON files and skip the AUR package', () => {
  const root = makeFixture();
  const aurBefore = read(root, 'packaging/aur/openlinear-bin/PKGBUILD');
  const plan = planBump({ arg: '0.2.0-beta.1', root, tags: ['0.1.61'] });
  applyPlan(plan);
  assert.equal(JSON.parse(read(root, 'apps/desktop/src-tauri/tauri.conf.json')).version, '0.2.0-beta.1');
  assert.equal(JSON.parse(read(root, 'packages/openlinear-cli/package.json')).version, '0.2.0-beta.1');
  assert.equal(read(root, 'packaging/aur/openlinear-bin/PKGBUILD'), aurBefore);
  assert.ok(plan.notes.some((n) => n.includes('PKGBUILD: skipped (prerelease')));
});

test('CLI --dry-run against the real repository writes nothing', () => {
  const before = snapshot(REPO);
  const res = spawnSync(process.execPath, [SCRIPT, 'patch', '--dry-run'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\(dry run, nothing written\)/);
  for (const { file } of TARGETS) assert.ok(res.stdout.includes(file), `plan lists ${file}`);
  assert.deepEqual(snapshot(REPO), before);
});

test('CLI rejects unknown options and bad arguments with exit 1', () => {
  for (const args of [['patch', '--bogus'], [], ['patch', 'minor'], ['nope', '--dry-run']]) {
    const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8' });
    assert.equal(res.status, 1, `args ${JSON.stringify(args)}: ${res.stdout}`);
  }
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
});

test('tags are read from git when not supplied', (t) => {
  let tags;
  try {
    tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: REPO, encoding: 'utf8' });
  } catch {
    t.skip('git unavailable');
    return;
  }
  const plan = planBump({ arg: '99.0.0' });
  if (tags.trim() === '') assert.ok(plan.base);
  else assert.ok(!plan.notes.some((n) => n.includes('git tags unavailable')));
});
