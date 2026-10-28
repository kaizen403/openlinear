import { logger } from '../lib/logger';
import { SandboxUnavailableError } from './errors';
import { LinuxBubblewrapProvider } from './linux-bwrap';
import { MacSeatbeltProvider } from './macos-seatbelt';
import type { CapabilityReport, SandboxProvider } from './types';

/**
 * Selects the provider for this platform. Windows (and anything else) has no
 * provider: there is no OS boundary we have verified there, so execution
 * fails closed unless an explicit trusted-host grant applies.
 */
export function platformProvider(platform: NodeJS.Platform = process.platform): SandboxProvider | null {
  if (platform === 'darwin') return new MacSeatbeltProvider();
  if (platform === 'linux') return new LinuxBubblewrapProvider();
  return null;
}

const FAILURE_RETRY_MS = 30_000;

interface CacheEntry {
  provider: SandboxProvider | null;
  report: CapabilityReport;
  at: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;
let providerFactory: () => SandboxProvider | null = () => platformProvider();

function unavailableReport(reason: string): CapabilityReport {
  return {
    provider: 'none',
    providerVersion: null,
    platform: process.platform,
    available: false,
    checkedAt: new Date().toISOString(),
    durationMs: 0,
    enforced: { filesystem: false, env: false, network: false, process: false },
    probes: [],
    blockers: [reason],
    warnings: [],
    unsupported: [],
  };
}

async function verify(): Promise<CacheEntry> {
  const provider = providerFactory();
  if (!provider) {
    return { provider: null, report: unavailableReport(`no sandbox provider for platform ${process.platform}`), at: Date.now() };
  }
  const report = await provider.preflight();
  const level = report.available ? 'info' : 'error';
  logger[level]({
    provider: report.provider,
    providerVersion: report.providerVersion,
    available: report.available,
    enforced: report.enforced,
    blockers: report.blockers,
    unsupported: report.unsupported,
    durationMs: report.durationMs,
    probes: report.probes.map((probe) => `${probe.passed ? 'pass' : 'FAIL'}:${probe.name}`),
  }, '[Sandbox] preflight');
  return { provider, report, at: Date.now() };
}

/**
 * Returns a provider whose live canary preflight passed on this machine.
 * Success is cached for the process lifetime; failure is retried after 30 s
 * (so installing bubblewrap does not require a restart). Concurrent callers
 * share one preflight run.
 */
export async function getVerifiedProvider(): Promise<{ provider: SandboxProvider; report: CapabilityReport }> {
  const fresh = cache && (cache.report.available || Date.now() - cache.at < FAILURE_RETRY_MS);
  if (!fresh) {
    if (!inflight) {
      inflight = verify().finally(() => {
        inflight = null;
      });
    }
    cache = await inflight;
  }
  const entry = cache as CacheEntry;
  if (!entry.provider || !entry.report.available) {
    throw new SandboxUnavailableError('No verified sandbox is available for agent execution on this machine', entry.report.blockers);
  }
  return { provider: entry.provider, report: entry.report };
}

export function getLastCapabilityReport(): CapabilityReport | null {
  return cache?.report ?? null;
}

/** Test seam: replace the provider factory and clear cached verification. */
export function setProviderFactoryForTests(factory: (() => SandboxProvider | null) | null): void {
  providerFactory = factory ?? (() => platformProvider());
  cache = null;
  inflight = null;
}
