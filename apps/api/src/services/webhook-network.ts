import dns from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { HttpError } from '../errors';

/**
 * FE-14 webhooks: SSRF rules for outbound deliveries. See
 * docs/reports/revamp-2026-10-26/webhooks.md §5.
 *
 * A webhook URL is chosen by a user, and the API server sits next to things a
 * user must never reach through it (cloud metadata, the database, other
 * containers). So:
 *
 *   - registration accepts `https://` only, without credentials, fragments,
 *     single-label or internal host names, and IP literals in a refused range;
 *   - every connection resolves the host itself (`guardedLookup`) and refuses
 *     the attempt when ANY resolved address is in a refused range, then
 *     connects to the address it checked (no second resolution, so DNS
 *     rebinding between check and connect is impossible);
 *   - redirects are never followed and response bodies are read capped (in
 *     webhook-delivery.ts).
 *
 * Plain `http://` to a loopback address is allowed only after a test calls
 * `allowLoopbackWebhooksForTests(true)`, which refuses to run outside
 * NODE_ENV=test.
 */

export const MAX_WEBHOOK_URL_LENGTH = 2048;

/** IPv4 ranges never contacted (RFC 6890 special-purpose, private, metadata). */
const BLOCKED_V4: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (incl. Alibaba metadata 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255
  ['168.63.129.16', 32], // Azure platform (wire server / DNS), reachable from Azure hosts
];

/** IPv6 ranges never contacted. Embedded IPv4 forms are checked separately. */
const BLOCKED_V6: ReadonlyArray<[string, number]> = [
  ['::', 96], // unspecified, loopback (::1) and deprecated IPv4-compatible
  ['::ffff:0:0:0', 96], // IPv4-translated
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (incl. Teredo 2001::/32)
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation (RFC 9637)
  ['fc00::', 7], // unique local (incl. fd00::/8, AWS metadata fd00:ec2::254)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

const blocked = new BlockList();
for (const [address, prefix] of BLOCKED_V4) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of BLOCKED_V6) blocked.addSubnet(address, prefix, 'ipv6');

/** Eight 16-bit groups of an IPv6 address (also accepts a dotted IPv4 tail), or null. */
export function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const octets = tail.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const values = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return values.length === 8 && values.every((value) => Number.isInteger(value)) ? values : null;
}

function v4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * The IPv4 address an IPv6 address stands for, when it embeds one that a
 * router or the OS would actually reach: IPv4-mapped (::ffff:a.b.c.d),
 * NAT64 (64:ff9b::/96) and 6to4 (2002::/16). (IPv4-compatible ::a.b.c.d is
 * refused as a whole range.)
 */
export function embeddedIpv4(address: string): string | null {
  const g = ipv6Groups(address);
  if (!g) return null;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return v4FromGroups(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4FromGroups(g6, g7);
  if (g0 === 0x2002) return v4FromGroups(g1, g2);
  return null;
}

/** True when deliveries must never connect to `address` (an IP literal). */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family !== 6) return true; // not an address: refuse
  const v4 = embeddedIpv4(address);
  if (v4 !== null && blocked.check(v4, 'ipv4')) return true;
  const zone = address.indexOf('%');
  return blocked.check(zone === -1 ? address : address.slice(0, zone), 'ipv6');
}

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return address.startsWith('127.');
  if (family === 6) return address === '::1' || embeddedIpv4(address)?.startsWith('127.') === true;
  return false;
}

// ── Test hook ──────────────────────────────────────────────────────────────

let loopbackAllowed = false;

/**
 * Tests deliver to a local HTTP server on 127.0.0.1: this allows `http://`
 * URLs whose host is a loopback address or `localhost`, and nothing else.
 * Refuses to run outside NODE_ENV=test.
 */
export function allowLoopbackWebhooksForTests(allow: boolean): void {
  if (allow && process.env.NODE_ENV !== 'test') {
    throw new Error('allowLoopbackWebhooksForTests is only available under NODE_ENV=test');
  }
  loopbackAllowed = allow;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || isLoopbackAddress(hostname);
}

/** The loopback test exception applies to this URL. */
export function usesLoopbackTestException(url: URL): boolean {
  return loopbackAllowed && url.protocol === 'http:' && isLoopbackHost(bareHostname(url));
}

// ── URL rules ──────────────────────────────────────────────────────────────

/** `[::1]` → `::1`. */
export function bareHostname(url: URL): string {
  const host = url.hostname.toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.localdomain', '.corp'];

export type WebhookUrlProblem =
  | 'malformed'
  | 'too_long'
  | 'https_required'
  | 'credentials'
  | 'fragment'
  | 'internal_host'
  | 'forbidden_address'
  | 'port';

const PROBLEM_TEXT: Record<WebhookUrlProblem, string> = {
  malformed: 'Enter a full URL, e.g. https://example.com/hooks/openlinear',
  too_long: `The URL can be at most ${MAX_WEBHOOK_URL_LENGTH} characters`,
  https_required: 'Webhook URLs must use https://',
  credentials: 'Remove the user name and password from the URL; verify deliveries with the signing secret instead',
  fragment: 'Remove the #fragment from the URL',
  internal_host: 'Use a public host name; local and internal names are not reachable from OpenLinear',
  forbidden_address: 'The URL points at a private, loopback, link-local or reserved address',
  port: 'Use the standard HTTPS port (443) or 8443',
};

/** Ports deliveries may use (anything else turns the error texts into a port scanner). */
const ALLOWED_PORTS = new Set(['', '443', '8443']);

/** The problem with a webhook URL, or null when it may be registered. */
export function webhookUrlProblem(raw: string): WebhookUrlProblem | null {
  if (raw.length > MAX_WEBHOOK_URL_LENGTH) return 'too_long';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'malformed';
  }
  if (url.username || url.password) return 'credentials';
  if (url.hash || raw.includes('#')) return 'fragment';
  if (usesLoopbackTestException(url)) return null;
  if (url.protocol !== 'https:') return url.protocol === 'http:' ? 'https_required' : 'malformed';
  if (!ALLOWED_PORTS.has(url.port)) return 'port';
  const host = bareHostname(url);
  if (!host) return 'malformed';
  if (isIP(host)) return isForbiddenAddress(host) ? 'forbidden_address' : null;
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (name === 'localhost' || !name.includes('.') || INTERNAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return 'internal_host';
  }
  return null;
}

/** The URL as stored: parsed and re-serialized (lower-case host), or 400 WEBHOOK_URL_INVALID. */
export function normalizeWebhookUrl(raw: string): string {
  const trimmed = raw.trim();
  const problem = webhookUrlProblem(trimmed);
  if (problem) throw new HttpError(400, 'WEBHOOK_URL_INVALID', PROBLEM_TEXT[problem], { field: 'url', reason: problem });
  return new URL(trimmed).toString();
}

/** "https://hooks.example.com/…": what people without manage rights see (paths often carry tokens). */
export function displayWebhookUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return url.pathname === '/' && !url.search ? url.origin : `${url.origin}/…`;
  } catch {
    return '…';
  }
}

// ── Connection-time resolution ─────────────────────────────────────────────

export class ForbiddenAddressError extends Error {
  readonly code = 'WEBHOOK_ADDRESS_FORBIDDEN';
  constructor(readonly hostname: string, readonly address: string) {
    // The address stays server-side (`address`): echoing it would let anyone read private DNS answers back.
    super(`${hostname} resolves to an address OpenLinear does not contact`);
    this.name = 'ForbiddenAddressError';
  }
}

type Resolve = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/**
 * DNS for webhook hosts: a resolver with a timeout (one try) instead of
 * `dns.lookup`, whose uncancellable getaddrinfo calls run on libuv's small
 * thread pool — a slow, user-chosen DNS server could starve file, crypto and
 * database work. Literal IPs and the test-only loopback names use the OS.
 */
const resolver = new dns.Resolver({ timeout: 3_000, tries: 1 });

const systemResolve: Resolve = (hostname, options, callback) => {
  if (isIP(hostname) || (loopbackAllowed && isLoopbackHost(hostname.toLowerCase()))) {
    dns.lookup(hostname, options, callback);
    return;
  }
  const lookups: Array<Promise<dns.LookupAddress[]>> = [];
  const settle = (family: 4 | 6) => new Promise<dns.LookupAddress[]>((resolve) => {
    const done = (err: NodeJS.ErrnoException | null, addresses: string[]) => resolve(err ? [] : addresses.map((address) => ({ address, family })));
    if (family === 4) resolver.resolve4(hostname, done);
    else resolver.resolve6(hostname, done);
  });
  if (options.family !== 6) lookups.push(settle(4));
  if (options.family !== 4) lookups.push(settle(6));
  void Promise.all(lookups).then((results) => {
    const addresses = results.flat();
    if (addresses.length === 0) callback(Object.assign(new Error(`${hostname} did not resolve`), { code: 'ENOTFOUND' }), []);
    else callback(null, addresses);
  });
};

/**
 * A `lookup` for `http(s).request` that refuses hosts resolving to any
 * refused address. `resolve` is injectable for tests.
 */
export function createGuardedLookup(resolve: Resolve = systemResolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { family: options.family ?? 0, hints: options.hints, all: true }, (err, addresses) => {
      if (err) {
        callback(err, '', 0);
        return;
      }
      const allowLoopback = loopbackAllowed && isLoopbackHost(hostname.toLowerCase());
      const refused = addresses.find((entry) => isForbiddenAddress(entry.address) && !(allowLoopback && isLoopbackAddress(entry.address)));
      const first = addresses[0];
      if (refused || !first) {
        callback(refused ? new ForbiddenAddressError(hostname, refused.address) : Object.assign(new Error(`${hostname} did not resolve`), { code: 'ENOTFOUND' }), '', 0);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, first.address, first.family);
    });
  };
}

export const guardedLookup: LookupFunction = createGuardedLookup();

/**
 * Connection-time check of an IP-literal host (Node connects to literals
 * without calling `lookup`). Throws ForbiddenAddressError.
 */
export function assertConnectableHost(url: URL): void {
  const host = bareHostname(url);
  if (!isIP(host)) return;
  if (usesLoopbackTestException(url) && isLoopbackAddress(host)) return;
  if (isForbiddenAddress(host)) throw new ForbiddenAddressError(host, host);
}
