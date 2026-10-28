// Downloads the OpenLinear Linux AppImage for this package's version from the
// GitHub release and verifies it against the release's SHA256SUMS before it
// is installed. Used by the npm postinstall hook and `openlinear install`.
//
// Failure policy:
//   - unsupported platform, workspace checkout, opt-out, no such release,
//     no AppImage/checksum in it, network trouble -> skip with a message and
//     exit 0, so `npm install` never fails because an artifact is missing;
//   - checksum mismatch -> IntegrityError, nothing is installed, exit 1.

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

// Where release.yml publishes desktop builds.
const DEFAULT_RELEASE_REPO = 'kaizen403/openlinear';
const CHECKSUMS_ASSET = 'SHA256SUMS';
const MAX_REDIRECTS = 5;
const SOCKET_TIMEOUT_MS = 30_000;

class IntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntegrityError';
  }
}

class HttpStatusError extends Error {
  constructor(url, status) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

function releasesPageUrl(env = process.env) {
  return `https://github.com/${env.OPENLINEAR_RELEASE_REPO || DEFAULT_RELEASE_REPO}/releases`;
}

function releaseBaseUrl(version, env = process.env) {
  const override = env.OPENLINEAR_RELEASE_BASE_URL;
  const base = override || `${releasesPageUrl(env)}/download/v${version}`;
  const parsed = new URL(base);
  if (parsed.protocol !== 'https:') {
    throw new Error(`refusing non-https release URL: ${base}`);
  }
  return base.replace(/\/+$/, '');
}

/** The release asset for this platform, or null when none is published. */
function assetNameFor(version, platform, arch) {
  if (platform === 'linux' && arch === 'x64') {
    return `openlinear-${version}-x86_64.AppImage`;
  }
  return null;
}

/** Parses `sha256sum` output ("<hex>  <name>" or "<hex> *<name>"). */
function parseChecksums(text) {
  const sums = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (match) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

/** Returns a human-readable reason to skip the download, or null. */
function skipReason({ env, platform, arch, packageDir, checkWorkspace = true }) {
  if (env.OPENLINEAR_SKIP_DOWNLOAD === '1') {
    return 'OPENLINEAR_SKIP_DOWNLOAD=1 is set';
  }
  // Installed as a workspace package of the OpenLinear monorepo (pnpm install
  // in a checkout): there is no published release for the dev version.
  if (checkWorkspace && fs.existsSync(path.join(packageDir, '..', '..', 'pnpm-workspace.yaml'))) {
    return 'running inside the OpenLinear source checkout';
  }
  if (!assetNameFor('0.0.0', platform, arch)) {
    return `no desktop download for ${platform}/${arch} via npm yet; get the macOS .dmg or Linux .deb from ${releasesPageUrl(env)}`;
  }
  return null;
}

function request(url, redirectsLeft, onResponse) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      reject(new Error(`refusing non-https URL: ${url}`));
      return;
    }
    const req = https.get(parsed, { headers: { 'user-agent': 'openlinear-cli' } }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`too many redirects for ${url}`));
          return;
        }
        const next = new URL(response.headers.location, parsed).toString();
        request(next, redirectsLeft - 1, onResponse).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new HttpStatusError(url, status));
        return;
      }
      onResponse(response).then(resolve, reject);
    });
    req.setTimeout(SOCKET_TIMEOUT_MS, () => {
      req.destroy(new Error(`timed out after ${SOCKET_TIMEOUT_MS / 1000}s waiting for ${url}`));
    });
    req.on('error', reject);
  });
}

const httpsTransport = {
  getText(url) {
    return request(url, MAX_REDIRECTS, (response) => new Promise((resolve, reject) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    }));
  },
  /** Streams `url` into `destination`; resolves with the SHA-256 (hex). */
  download(url, destination) {
    return request(url, MAX_REDIRECTS, (response) => new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const file = fs.createWriteStream(destination, { mode: 0o600 });
      response.on('data', (chunk) => hash.update(chunk));
      response.on('error', reject);
      file.on('error', reject);
      file.on('finish', () => resolve(hash.digest('hex')));
      response.pipe(file);
    }));
  },
};

/**
 * Installs the AppImage for `version`. Resolves with
 * `{ status: 'installed' | 'skipped' | 'unavailable', message }`; rejects
 * with IntegrityError on a checksum mismatch and with other errors on
 * network/filesystem failures.
 */
async function install({
  version,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  homeDir = os.homedir(),
  packageDir = path.join(__dirname, '..'),
  transport = httpsTransport,
  ignoreWorkspace = false,
}) {
  const reason = skipReason({ env, platform, arch, packageDir, checkWorkspace: !ignoreWorkspace });
  if (reason) {
    return { status: 'skipped', message: `Skipping the OpenLinear AppImage download: ${reason}.` };
  }

  const assetName = assetNameFor(version, platform, arch);
  const baseUrl = releaseBaseUrl(version, env);

  let checksums;
  try {
    checksums = parseChecksums(await transport.getText(`${baseUrl}/${CHECKSUMS_ASSET}`));
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 404) {
      return {
        status: 'unavailable',
        message: `Release v${version} has no ${CHECKSUMS_ASSET} at ${baseUrl}; the AppImage was not downloaded. See ${releasesPageUrl(env)}.`,
      };
    }
    throw error;
  }

  const expected = checksums.get(assetName);
  if (!expected) {
    return {
      status: 'unavailable',
      message: `Release v${version} does not list ${assetName} in ${CHECKSUMS_ASSET}; the AppImage was not downloaded. See ${releasesPageUrl(env)}.`,
    };
  }

  const installDir = path.join(homeDir, '.openlinear');
  const target = path.join(installDir, 'openlinear.AppImage');
  const partial = `${target}.download`;
  fs.mkdirSync(installDir, { recursive: true, mode: 0o700 });
  fs.rmSync(partial, { force: true });

  let actual;
  try {
    actual = await transport.download(`${baseUrl}/${assetName}`, partial);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    if (error instanceof HttpStatusError && error.status === 404) {
      return {
        status: 'unavailable',
        message: `${assetName} is listed in ${CHECKSUMS_ASSET} but not downloadable (404); nothing was installed.`,
      };
    }
    throw error;
  }

  if (actual !== expected) {
    fs.rmSync(partial, { force: true });
    throw new IntegrityError(
      `${assetName} failed checksum verification (expected ${expected}, got ${actual}); nothing was installed.`,
    );
  }

  fs.chmodSync(partial, 0o755);
  fs.renameSync(partial, target);
  return { status: 'installed', message: `OpenLinear ${version} AppImage verified (sha256 ${actual}) and installed to ${target}` };
}

module.exports = {
  DEFAULT_RELEASE_REPO,
  HttpStatusError,
  IntegrityError,
  assetNameFor,
  httpsTransport,
  install,
  parseChecksums,
  releaseBaseUrl,
  releasesPageUrl,
  skipReason,
};
