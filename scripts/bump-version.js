#!/usr/bin/env node
// Bumps the desktop release version in every file that carries it.
//
// Usage:
//   node scripts/bump-version.js <patch|minor|major|X.Y.Z[-PRERELEASE]> [--dry-run] [--no-tags]
//
// - patch/minor/major start from the highest of tauri.conf.json's version and
//   the newest vX.Y.Z git tag. release.yml stamps the tag's version into
//   tauri.conf.json at build time, so the committed file can lag behind the
//   tags (it said 0.1.0 while releases reached v0.1.61). --no-tags ignores tags.
// - Every target is read and rewritten in memory first; nothing is written if
//   any file is missing or does not have the expected shape. Files are then
//   replaced via temp file + rename.
// - --dry-run prints the plan and writes nothing.
// - The script never commits, tags or pushes. Release flow: run it, review the
//   diff, commit `chore(release): vX.Y.Z`, tag `vX.Y.Z`, push the tag
//   (release.yml builds from the tag).
//
// Tests: node --test scripts/bump-version.test.js

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BUMP_TYPES = ['patch', 'minor', 'major'];
// Same shape release.yml accepts for tags (minus the leading v).
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const DEFAULT_ROOT = path.join(__dirname, '..');
const AUR_DIR = 'packaging/aur/openlinear-bin';

function parseVersion(version) {
  const m = VERSION_RE.exec(version);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`cannot compare "${a}" and "${b}"`);
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1; // a release sorts after its prereleases
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

// npm-style increment: bumping a prerelease finishes it (1.2.0-rc.1 + patch
// = 1.2.0; + minor = 1.2.0; 1.2.3-rc.1 + minor = 1.3.0).
function incrementVersion(base, type) {
  const v = parseVersion(base);
  if (!v) throw new Error(`invalid base version "${base}"`);
  if (type === 'major') {
    return v.pre && v.minor === 0 && v.patch === 0 ? `${v.major}.0.0` : `${v.major + 1}.0.0`;
  }
  if (type === 'minor') {
    return v.pre && v.patch === 0 ? `${v.major}.${v.minor}.0` : `${v.major}.${v.minor + 1}.0`;
  }
  return v.pre ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}.${v.patch + 1}`;
}

/** Versions of the repository's vX.Y.Z[-pre] tags; null when git is unavailable. */
function readTagVersions(root) {
  try {
    const out = execFileSync('git', ['tag', '--list', 'v*'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((t) => t.trim().replace(/^v/, ''))
      .filter((t) => parseVersion(t) !== null);
  } catch {
    return null;
  }
}

// Replaces exactly one match of `re` (which must exist) using `fn`.
function replaceOnce(content, re, fn, what) {
  const matches = content.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`));
  const count = matches?.length ?? 0;
  if (count !== 1) throw new Error(`expected exactly one ${what}, found ${count}`);
  return content.replace(re, fn);
}

// Edits only the top-level "version" line, so the rest of the file keeps its
// formatting (tauri.conf.json does not round-trip through JSON.stringify).
function jsonVersionTarget(file) {
  return {
    file,
    read(content) {
      const version = JSON.parse(content).version;
      if (typeof version !== 'string') throw new Error('has no string "version" field');
      return version;
    },
    write(content, next) {
      const out = replaceOnce(
        content,
        /^( {2}"version":\s*)"[^"]*"/m,
        (_m, prefix) => `${prefix}${JSON.stringify(next)}`,
        'top-level "version" line (two-space indent)',
      );
      if (JSON.parse(out).version !== next) throw new Error('top-level "version" did not change as expected');
      return out;
    },
  };
}

// Arch pkgver may not contain '-', and the AUR package tracks stable releases
// only, so AUR targets are skipped for prereleases.
const TARGETS = [
  jsonVersionTarget('apps/desktop/src-tauri/tauri.conf.json'),
  jsonVersionTarget('apps/desktop/package.json'),
  // The npm CLI downloads the AppImage of its own package version.
  jsonVersionTarget('packages/openlinear-cli/package.json'),
  {
    file: `${AUR_DIR}/PKGBUILD`,
    stableOnly: true,
    read(content) {
      const m = /^pkgver=(\S+)$/m.exec(content);
      if (!m) throw new Error('has no pkgver= line');
      return m[1];
    },
    write(content, next) {
      let out = replaceOnce(content, /^pkgver=.*$/m, () => `pkgver=${next}`, 'pkgver= line');
      out = replaceOnce(out, /^pkgrel=.*$/m, () => 'pkgrel=1', 'pkgrel= line');
      return out;
    },
  },
  {
    file: `${AUR_DIR}/.SRCINFO`,
    stableOnly: true,
    read(content) {
      const m = /^\s*pkgver = (\S+)$/m.exec(content);
      if (!m) throw new Error('has no "pkgver =" line');
      return m[1];
    },
    write(content, next) {
      const current = this.read(content);
      const escaped = current.replace(/\./g, '\\.');
      let out = replaceOnce(content, /^(\s*)pkgver = .*$/m, (_m, indent) => `${indent}pkgver = ${next}`, '"pkgver =" line');
      out = replaceOnce(out, /^(\s*)pkgrel = .*$/m, (_m, indent) => `${indent}pkgrel = 1`, '"pkgrel =" line');
      // Source URLs embed the version (".../download/v0.1.0/openlinear-0.1.0-x86_64.AppImage").
      out = out.replace(new RegExp(`(/v|openlinear-)${escaped}(?=[/-])`, 'g'), `$1${next}`);
      return out;
    },
  },
];

/**
 * Computes every file change without writing. Throws (before any write) on a
 * bad argument, a missing or malformed target, or an already-tagged version.
 * @param {{ arg: string, root?: string, tags?: string[] | null }} options
 *   tags: tag versions without the leading "v"; undefined reads them from git,
 *   null ignores tags.
 */
function planBump({ arg, root = DEFAULT_ROOT, tags }) {
  if (!arg) throw new Error('missing argument: patch, minor, major or X.Y.Z[-PRERELEASE]');
  const tagVersions = tags === undefined ? readTagVersions(root) : tags;
  const notes = [];

  const files = TARGETS.map((target) => {
    const abs = path.join(root, target.file);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      throw new Error(
        `${target.file}: cannot read (${err.code ?? err.message}). If the file was removed on purpose, update TARGETS in scripts/bump-version.js.`,
      );
    }
    let current;
    try {
      current = target.read(content);
    } catch (err) {
      throw new Error(`${target.file}: ${err.message}`);
    }
    return { target, abs, content, current };
  });

  const fileVersion = files[0].current;
  if (!parseVersion(fileVersion)) throw new Error(`${files[0].target.file}: invalid version "${fileVersion}"`);
  const stableTags = (tagVersions ?? []).filter((t) => parseVersion(t).pre === null);
  const newestTag = stableTags.reduce((max, t) => (max === null || compareVersions(t, max) > 0 ? t : max), null);
  if (tagVersions === null && tags === undefined) notes.push('git tags unavailable; using the version in tauri.conf.json');

  const base = newestTag !== null && compareVersions(newestTag, fileVersion) > 0 ? newestTag : fileVersion;
  if (base !== fileVersion) notes.push(`tauri.conf.json says ${fileVersion}; newest tag is v${newestTag}, bumping from it`);

  let next;
  if (BUMP_TYPES.includes(arg)) {
    next = incrementVersion(base, arg);
  } else if (parseVersion(arg)) {
    next = arg;
  } else {
    throw new Error(`invalid argument "${arg}": use patch, minor, major or X.Y.Z[-PRERELEASE]`);
  }

  if ((tagVersions ?? []).includes(next)) throw new Error(`tag v${next} already exists`);
  if (newestTag !== null && compareVersions(next, newestTag) <= 0) {
    throw new Error(`${next} is not newer than the newest tag v${newestTag}`);
  }
  const isPre = parseVersion(next).pre !== null;

  const changes = [];
  for (const { target, abs, content, current } of files) {
    if (target.stableOnly && isPre) {
      notes.push(`${target.file}: skipped (prerelease; the AUR package tracks stable releases)`);
      continue;
    }
    let updated;
    try {
      updated = target.write(content, next);
    } catch (err) {
      throw new Error(`${target.file}: ${err.message}`);
    }
    changes.push({ file: target.file, abs, from: current, to: next, content: updated, changed: updated !== content });
  }
  return { base, next, changes, notes };
}

/** Writes a plan from planBump: temp file + rename per target. */
function applyPlan(plan) {
  for (const change of plan.changes) {
    if (!change.changed) continue;
    const tmp = `${change.abs}.bump-${process.pid}.tmp`;
    fs.writeFileSync(tmp, change.content);
    fs.renameSync(tmp, change.abs);
  }
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const usage = 'Usage: node scripts/bump-version.js <patch|minor|major|X.Y.Z[-PRERELEASE]> [--dry-run] [--no-tags]';
  if (flags.has('--help')) {
    console.log(usage);
    return 0;
  }
  const unknown = [...flags].filter((f) => f !== '--dry-run' && f !== '--no-tags');
  if (unknown.length > 0 || positional.length !== 1) {
    if (unknown.length > 0) console.error(`Unknown option(s): ${unknown.join(', ')}`);
    console.error(usage);
    return 1;
  }
  const dryRun = flags.has('--dry-run');
  let plan;
  try {
    plan = planBump({ arg: positional[0], tags: flags.has('--no-tags') ? null : undefined });
  } catch (err) {
    console.error(`bump-version: ${err.message}`);
    return 1;
  }
  for (const note of plan.notes) console.log(`note: ${note}`);
  console.log(`${plan.base} → ${plan.next}${dryRun ? ' (dry run, nothing written)' : ''}`);
  for (const c of plan.changes) {
    console.log(`  ${c.file}: ${c.from} → ${c.to}${c.changed ? '' : ' (unchanged)'}`);
  }
  if (!dryRun) {
    applyPlan(plan);
    console.log(`Next: review the diff, commit "chore(release): v${plan.next}", tag v${plan.next}, push the tag.`);
  }
  return 0;
}

module.exports = { planBump, applyPlan, incrementVersion, compareVersions, parseVersion, TARGETS };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
