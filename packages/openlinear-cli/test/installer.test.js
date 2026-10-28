const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HttpStatusError,
  IntegrityError,
  assetNameFor,
  install,
  parseChecksums,
  releaseBaseUrl,
  skipReason,
} = require('../lib/installer');

const VERSION = '0.2.0';
const ASSET = `openlinear-${VERSION}-x86_64.AppImage`;
const BASE = `https://github.com/kaizen403/openlinear/releases/download/v${VERSION}`;
const PAYLOAD = Buffer.from('#!/bin/sh\necho openlinear\n');
const PAYLOAD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openlinear-cli-test-'));
}

/** In-memory transport: url -> { status, body }. Records requested URLs. */
function fakeTransport(routes) {
  const requested = [];
  return {
    requested,
    async getText(url) {
      requested.push(url);
      const route = routes[url];
      if (route?.status !== 200) throw new HttpStatusError(url, route ? route.status : 404);
      return route.body.toString('utf8');
    },
    async download(url, destination) {
      requested.push(url);
      const route = routes[url];
      if (route?.status !== 200) throw new HttpStatusError(url, route ? route.status : 404);
      fs.writeFileSync(destination, route.body);
      return crypto.createHash('sha256').update(route.body).digest('hex');
    },
  };
}

const linux = { platform: 'linux', arch: 'x64', env: {}, packageDir: path.join(os.tmpdir(), 'no-workspace', 'pkg') };

test('downloads from the repository that publishes releases', () => {
  assert.equal(releaseBaseUrl(VERSION, {}), BASE);
  assert.equal(
    releaseBaseUrl(VERSION, { OPENLINEAR_RELEASE_REPO: 'openlinear/openlinear' }),
    `https://github.com/openlinear/openlinear/releases/download/v${VERSION}`,
  );
  assert.throws(() => releaseBaseUrl(VERSION, { OPENLINEAR_RELEASE_BASE_URL: 'http://example.com/x' }), /non-https/);
});

test('only Linux x64 has an npm-installed artifact', () => {
  assert.equal(assetNameFor(VERSION, 'linux', 'x64'), ASSET);
  assert.equal(assetNameFor(VERSION, 'darwin', 'arm64'), null);
  assert.equal(assetNameFor(VERSION, 'linux', 'arm64'), null);
});

test('parses sha256sum output', () => {
  const sums = parseChecksums(`${'a'.repeat(64)}  ${ASSET}\n${'B'.repeat(64)} *other.deb\n# comment\n\ngarbage line\n`);
  assert.equal(sums.get(ASSET), 'a'.repeat(64));
  assert.equal(sums.get('other.deb'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('skips on opt-out, unsupported platforms and inside the source checkout', () => {
  assert.match(skipReason({ ...linux, env: { OPENLINEAR_SKIP_DOWNLOAD: '1' } }), /OPENLINEAR_SKIP_DOWNLOAD/);
  assert.match(skipReason({ ...linux, platform: 'darwin', arch: 'arm64' }), /darwin\/arm64/);
  assert.equal(skipReason(linux), null);
  // This test file lives in the monorepo, so the real package dir is a workspace.
  assert.match(skipReason({ ...linux, packageDir: path.join(__dirname, '..') }), /source checkout/);
  assert.equal(skipReason({ ...linux, packageDir: path.join(__dirname, '..'), checkWorkspace: false }), null);
});

test('a missing release is reported as unavailable, not thrown', async () => {
  const homeDir = tempDir();
  const result = await install({ ...linux, version: VERSION, homeDir, transport: fakeTransport({}) });
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /no SHA256SUMS/);
  assert.equal(fs.existsSync(path.join(homeDir, '.openlinear', 'openlinear.AppImage')), false);
});

test('a release without the AppImage is reported as unavailable', async () => {
  const homeDir = tempDir();
  const transport = fakeTransport({
    [`${BASE}/SHA256SUMS`]: { status: 200, body: Buffer.from(`${'c'.repeat(64)}  openlinear-${VERSION}-aarch64.dmg\n`) },
  });
  const result = await install({ ...linux, version: VERSION, homeDir, transport });
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /does not list/);
});

test('verifies the checksum and installs atomically', async () => {
  const homeDir = tempDir();
  const transport = fakeTransport({
    [`${BASE}/SHA256SUMS`]: { status: 200, body: Buffer.from(`${PAYLOAD_SHA}  ${ASSET}\n`) },
    [`${BASE}/${ASSET}`]: { status: 200, body: PAYLOAD },
  });
  const result = await install({ ...linux, version: VERSION, homeDir, transport });
  assert.equal(result.status, 'installed');
  const target = path.join(homeDir, '.openlinear', 'openlinear.AppImage');
  assert.deepEqual(fs.readFileSync(target), PAYLOAD);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(`${target}.download`), false);
  assert.deepEqual(transport.requested, [`${BASE}/SHA256SUMS`, `${BASE}/${ASSET}`]);
});

test('a checksum mismatch installs nothing and keeps the previous AppImage', async () => {
  const homeDir = tempDir();
  const target = path.join(homeDir, '.openlinear', 'openlinear.AppImage');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'previous');
  const transport = fakeTransport({
    [`${BASE}/SHA256SUMS`]: { status: 200, body: Buffer.from(`${'d'.repeat(64)}  ${ASSET}\n`) },
    [`${BASE}/${ASSET}`]: { status: 200, body: PAYLOAD },
  });
  await assert.rejects(install({ ...linux, version: VERSION, homeDir, transport }), IntegrityError);
  assert.equal(fs.readFileSync(target, 'utf8'), 'previous');
  assert.equal(fs.existsSync(`${target}.download`), false);
});

test('skipped installs make no network requests', async () => {
  const transport = fakeTransport({});
  const result = await install({ ...linux, platform: 'darwin', arch: 'arm64', version: VERSION, homeDir: tempDir(), transport });
  assert.equal(result.status, 'skipped');
  assert.deepEqual(transport.requested, []);
});
