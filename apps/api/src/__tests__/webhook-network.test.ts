/**
 * FE-14 webhooks: SSRF rules (pure; no network). Refused address ranges for
 * IPv4 and IPv6 (embedded IPv4 forms included), URL registration rules, the
 * connection-time lookup guard (injected resolver) and IP-literal checks.
 */
import type { LookupAddress } from 'node:dns';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ForbiddenAddressError,
  allowLoopbackWebhooksForTests,
  assertConnectableHost,
  createGuardedLookup,
  displayWebhookUrl,
  embeddedIpv4,
  ipv6Groups,
  isForbiddenAddress,
  normalizeWebhookUrl,
  webhookUrlProblem,
} from '../services/webhook-network';

afterEach(() => allowLoopbackWebhooksForTests(false));

describe('security review fixes', () => {
  it('refuses the Azure platform address and the RFC 9637 documentation range', () => {
    expect(isForbiddenAddress('168.63.129.16')).toBe(true);
    expect(isForbiddenAddress('3fff::1')).toBe(true);
    expect(isForbiddenAddress('8.8.8.8')).toBe(false);
  });

  it('allows only the standard HTTPS ports', () => {
    expect(webhookUrlProblem('https://hooks.example.com/x')).toBeNull();
    expect(webhookUrlProblem('https://hooks.example.com:443/x')).toBeNull();
    expect(webhookUrlProblem('https://hooks.example.com:8443/x')).toBeNull();
    expect(webhookUrlProblem('https://hooks.example.com:22/x')).toBe('port');
    expect(webhookUrlProblem('https://hooks.example.com:6379/x')).toBe('port');
  });

  it('never echoes a refused address back (no DNS oracle)', () => {
    const error = new ForbiddenAddressError('internal.example.com', '10.1.2.3');
    expect(error.message).toBe('internal.example.com resolves to an address OpenLinear does not contact');
    expect(error.message).not.toContain('10.1.2.3');
    expect(error.address).toBe('10.1.2.3');
  });
});

describe('refused addresses', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.100.100.200', '127.0.0.1', '127.255.255.254', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.7',
    '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  ])('refuses IPv4 %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each([
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1',
    '::127.0.0.1', '::ffff:0:10.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::1', '2002:a9fe:a9fe::1', '2002:7f00:1::',
    'fc00::1', 'fd00::1', 'fd00:ec2::254', 'fe80::1', 'fe80::1%en0', 'fec0::1', 'ff02::1', '2001:db8::1', '2001::1', '100::1',
  ])('refuses IPv6 %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])(
    'allows public %s',
    (address) => {
      expect(isForbiddenAddress(address)).toBe(false);
    },
  );

  it('refuses anything that is not an IP address', () => {
    expect(isForbiddenAddress('example.com')).toBe(true);
    expect(isForbiddenAddress('')).toBe(true);
  });

  it('expands IPv6 and finds embedded IPv4', () => {
    expect(ipv6Groups('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(ipv6Groups('1::2::3')).toBeNull();
    expect(embeddedIpv4('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
    expect(embeddedIpv4('64:ff9b::808:808')).toBe('8.8.8.8');
    expect(embeddedIpv4('2002:c0a8:101::')).toBe('192.168.1.1');
    expect(embeddedIpv4('2606:4700::1')).toBeNull();
  });
});

describe('URL registration rules', () => {
  it.each([
    ['http://example.com/hook', 'https_required'],
    ['ftp://example.com/hook', 'malformed'],
    ['not a url', 'malformed'],
    ['https://user:pw@example.com/hook', 'credentials'],
    ['https://example.com/hook#frag', 'fragment'],
    ['https://localhost/hook', 'internal_host'],
    ['https://intranet/hook', 'internal_host'],
    ['https://api.internal/hook', 'internal_host'],
    ['https://metadata.google.internal/computeMetadata/v1', 'internal_host'],
    ['https://printer.local/hook', 'internal_host'],
    ['https://169.254.169.254/latest/meta-data', 'forbidden_address'],
    ['https://10.0.0.1/hook', 'forbidden_address'],
    ['https://2130706433/hook', 'forbidden_address'], // 127.0.0.1 in decimal
    ['https://0x7f.1/hook', 'forbidden_address'], // 127.0.0.1 in hex
    ['https://[::1]/hook', 'forbidden_address'],
    ['https://[::ffff:169.254.169.254]/hook', 'forbidden_address'],
    ['https://[fd00:ec2::254]/hook', 'forbidden_address'],
    [`https://example.com/${'a'.repeat(2100)}`, 'too_long'],
  ])('%s → %s', (url, problem) => {
    expect(webhookUrlProblem(url)).toBe(problem);
  });

  it('accepts public https URLs and normalizes them', () => {
    expect(webhookUrlProblem('https://hooks.example.com/openlinear?x=1')).toBeNull();
    expect(webhookUrlProblem('https://93.184.216.34:8443/hook')).toBeNull();
    expect(normalizeWebhookUrl('  https://Hooks.Example.COM/a  ')).toBe('https://hooks.example.com/a');
    expect(() => normalizeWebhookUrl('http://example.com')).toThrow(expect.objectContaining({ code: 'WEBHOOK_URL_INVALID', statusCode: 400 }));
  });

  it('allows http loopback only under the explicit test hook', () => {
    expect(webhookUrlProblem('http://127.0.0.1:9999/hook')).toBe('https_required');
    allowLoopbackWebhooksForTests(true);
    expect(webhookUrlProblem('http://127.0.0.1:9999/hook')).toBeNull();
    expect(webhookUrlProblem('http://localhost:9999/hook')).toBeNull();
    // The hook covers plain-http loopback only: nothing else opens up.
    expect(webhookUrlProblem('http://example.com/hook')).toBe('https_required');
    expect(webhookUrlProblem('https://127.0.0.1/hook')).toBe('forbidden_address');
    expect(webhookUrlProblem('http://10.0.0.1/hook')).toBe('https_required');
  });

  it('refuses the test hook outside NODE_ENV=test', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => allowLoopbackWebhooksForTests(true)).toThrow(/NODE_ENV=test/);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('shows only the origin to people who cannot manage the endpoint', () => {
    expect(displayWebhookUrl('https://hooks.slack.com/services/T000/B000/secret')).toBe('https://hooks.slack.com/…');
    expect(displayWebhookUrl('https://example.com/')).toBe('https://example.com');
    expect(displayWebhookUrl('https://example.com/?token=x')).toBe('https://example.com/…');
  });
});

describe('connection-time checks', () => {
  function lookupWith(addresses: LookupAddress[]) {
    return createGuardedLookup((_host, _options, callback) => callback(null, addresses));
  }

  function run(lookup: ReturnType<typeof createGuardedLookup>, host: string, all: boolean) {
    return new Promise<{ err: NodeJS.ErrnoException | null; address: string | LookupAddress[] }>((resolve) => {
      lookup(host, { all }, (err, address) => resolve({ err, address }));
    });
  }

  it('connects to the checked address when every resolved address is public', async () => {
    const lookup = lookupWith([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]);
    expect(await run(lookup, 'example.com', false)).toEqual({ err: null, address: '93.184.216.34' });
    expect((await run(lookup, 'example.com', true)).address).toHaveLength(2);
  });

  it('refuses a host when any resolved address is refused (no mixed answers, no rebinding)', async () => {
    for (const address of ['10.0.0.5', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::2']) {
      const lookup = lookupWith([{ address: '93.184.216.34', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }]);
      const { err } = await run(lookup, 'rebind.example.com', true);
      expect(err).toBeInstanceOf(ForbiddenAddressError);
      expect(err?.code).toBe('WEBHOOK_ADDRESS_FORBIDDEN');
    }
  });

  it('passes resolver errors through and treats an empty answer as unresolved', async () => {
    const failing = createGuardedLookup((_host, _options, callback) => callback(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }), []));
    expect((await run(failing, 'missing.example.com', false)).err?.code).toBe('ENOTFOUND');
    expect((await run(lookupWith([]), 'empty.example.com', false)).err?.code).toBe('ENOTFOUND');
  });

  it('lets loopback through only for loopback hosts under the test hook', async () => {
    const lookup = lookupWith([{ address: '127.0.0.1', family: 4 }]);
    expect((await run(lookup, 'localhost', false)).err).toBeInstanceOf(ForbiddenAddressError);
    allowLoopbackWebhooksForTests(true);
    expect(await run(lookup, 'localhost', false)).toEqual({ err: null, address: '127.0.0.1' });
    expect((await run(lookup, 'evil.example.com', false)).err).toBeInstanceOf(ForbiddenAddressError);
  });

  it('checks IP-literal hosts before connecting', () => {
    expect(() => assertConnectableHost(new URL('https://169.254.169.254/'))).toThrow(ForbiddenAddressError);
    expect(() => assertConnectableHost(new URL('https://[::ffff:a9fe:a9fe]/'))).toThrow(ForbiddenAddressError);
    expect(() => assertConnectableHost(new URL('https://93.184.216.34/'))).not.toThrow();
    expect(() => assertConnectableHost(new URL('https://example.com/'))).not.toThrow();
    expect(() => assertConnectableHost(new URL('http://127.0.0.1:1/'))).toThrow(ForbiddenAddressError);
    allowLoopbackWebhooksForTests(true);
    expect(() => assertConnectableHost(new URL('http://127.0.0.1:1/'))).not.toThrow();
    expect(() => assertConnectableHost(new URL('https://127.0.0.1:1/'))).toThrow(ForbiddenAddressError);
  });
});
