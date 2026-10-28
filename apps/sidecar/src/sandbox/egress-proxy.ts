import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { chmodSync, rmSync } from 'node:fs';
import type { Duplex } from 'node:stream';

/**
 * Per-attempt egress proxy. The sandbox lets the agent reach exactly one
 * endpoint (this proxy); the proxy decides which destinations are allowed.
 *
 * - CONNECT only (HTTPS and other TLS tunnels). Plain-HTTP absolute-form
 *   requests are refused, so no request body or header is ever parsed or
 *   rewritten here and TLS stays end-to-end between the agent and the host.
 * - Host patterns: `example.com`, `*.example.com`, optional `:port`. A
 *   pattern without a port allows 443 only, so an allowed host cannot be
 *   used to tunnel SSH or other protocols.
 * - Allowed hostnames are resolved once here and every address in a denied
 *   class (loopback, link-local, unspecified, multicast, cloud metadata, …)
 *   is dropped before dialing, so DNS for an allowed name cannot be pointed
 *   at the host's own services. IP literals must be listed explicitly, and
 *   a listed literal in one of those classes is still refused unless the
 *   proxy is built with `allowLocalTargets` (the sandbox self-test's
 *   loopback canary): allow lists also come from project settings and
 *   repository files, and the host runs services (the sidecar, the shared
 *   OpenCode server, databases) that a sandboxed step must never reach.
 * - Each attempt gets its own proxy instance: no global mutable policy is
 *   shared between concurrent attempts.
 */

export interface HostRule {
  /** Lower-case host, `*.` wildcard prefix, or an IP literal. */
  host: string;
  /** `null`: 443 only. */
  port: number | null;
  wildcard: boolean;
  ipLiteral: boolean;
}

export interface ProxyDecision {
  at: string;
  host: string;
  port: number;
  allowed: boolean;
  reason: string;
}

export interface EgressProxyOptions {
  allow: readonly string[];
  listen: { kind: 'tcp' } | { kind: 'unix'; path: string };
  /** Injectable for tests. */
  resolve?: (host: string) => Promise<string[]>;
  maxConnections?: number;
  idleTimeoutMs?: number;
  onDecision?: (decision: ProxyDecision) => void;
  /**
   * Allowlisted IP literals in a denied class (loopback, link-local,
   * metadata, …) are reachable. Only for the sandbox self-test, whose canary
   * listens on loopback; never for allow lists that settings can influence.
   */
  allowLocalTargets?: boolean;
}

const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function parseHostRule(raw: string): HostRule {
  const value = raw.trim().toLowerCase();
  if (!value) throw new Error('[sandbox] empty proxy host rule');
  let host = value;
  let port: number | null = null;
  const bracket = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(value);
  if (bracket) {
    host = bracket[1];
    port = bracket[2] ? Number(bracket[2]) : null;
  } else {
    const colon = value.lastIndexOf(':');
    if (colon !== -1) {
      if (value.indexOf(':') !== colon) throw new Error(`[sandbox] IPv6 proxy rules must be bracketed: ${raw}`);
      host = value.slice(0, colon);
      port = Number(value.slice(colon + 1));
    }
  }
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`[sandbox] invalid port in proxy rule: ${raw}`);
  }
  const ipLiteral = isIP(host) !== 0;
  const wildcard = host.startsWith('*.');
  if (!ipLiteral && !HOST_RE.test(host)) throw new Error(`[sandbox] invalid proxy host rule: ${raw}`);
  return { host, port, wildcard, ipLiteral };
}

function hostMatches(rule: HostRule, host: string): boolean {
  if (rule.ipLiteral) return rule.host === host;
  if (rule.wildcard) {
    const suffix = rule.host.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return rule.host === host;
}

export function matchRule(rules: readonly HostRule[], host: string, port: number): HostRule | null {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  for (const rule of rules) {
    if (!hostMatches(rule, normalized)) continue;
    if (rule.port === null ? port === 443 : rule.port === port) return rule;
  }
  return null;
}

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4(address: string, cidr: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(cidr) & mask);
}

/** Extracts an embedded IPv4 address from mapped/compatible/NAT64/6to4 forms. */
function embeddedV4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower);
  if (sixToFour) {
    const high = Number.parseInt(sixToFour[1], 16);
    const low = Number.parseInt(sixToFour[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return null;
}

/**
 * Address classes an allowed *hostname* must never resolve to. Private
 * (RFC 1918) space is not denied by default so intranet registries work;
 * loopback, link-local and metadata endpoints always are.
 */
export function deniedAddressClass(address: string): string | null {
  const family = isIP(address);
  if (family === 4) {
    if (inV4(address, '127.0.0.0', 8)) return 'loopback';
    if (inV4(address, '0.0.0.0', 8)) return 'unspecified';
    if (inV4(address, '169.254.0.0', 16)) return 'link-local';
    if (inV4(address, '224.0.0.0', 4)) return 'multicast';
    if (address === '255.255.255.255') return 'broadcast';
    if (address === '100.100.100.200' || address === '168.63.129.16' || address === '192.0.0.192') return 'cloud-metadata';
    return null;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const v4 = embeddedV4(lower);
    if (v4) return deniedAddressClass(v4);
    if (lower === '::1') return 'loopback';
    if (lower === '::') return 'unspecified';
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return 'link-local';
    if (lower.startsWith('ff')) return 'multicast';
    if (lower.startsWith('fd00:ec2:') || lower === 'fd20:ce::254' || lower === 'fd00:42::42') return 'cloud-metadata';
    return null;
  }
  return 'invalid';
}

async function defaultResolve(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

function parseConnectTarget(target: string | undefined): { host: string; port: number } | null {
  if (!target) return null;
  const bracket = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(target);
  if (bracket) return { host: bracket[1].toLowerCase(), port: Number(bracket[2]) };
  const plain = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(target);
  if (!plain) return null;
  const port = Number(plain[2]);
  if (port < 1 || port > 65535) return null;
  return { host: plain[1].toLowerCase(), port };
}

const MAX_DECISIONS = 200;

export class EgressProxy {
  private readonly rules: HostRule[];
  private readonly resolve: (host: string) => Promise<string[]>;
  private readonly maxConnections: number;
  private readonly idleTimeoutMs: number;
  private server: Server | null = null;
  private readonly sockets = new Set<Duplex>();
  private readonly decisionLog: ProxyDecision[] = [];
  private socketPath: string | null = null;
  allowedCount = 0;
  deniedCount = 0;

  constructor(private readonly options: EgressProxyOptions) {
    this.rules = options.allow.map(parseHostRule);
    this.resolve = options.resolve ?? defaultResolve;
    this.maxConnections = options.maxConnections ?? 256;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
  }

  get decisions(): readonly ProxyDecision[] {
    return this.decisionLog;
  }

  get allowedHosts(): string[] {
    return this.options.allow.map((rule) => rule.trim().toLowerCase());
  }

  async start(): Promise<{ kind: 'tcp'; port: number } | { kind: 'unix'; path: string }> {
    if (this.server) throw new Error('[sandbox] egress proxy already started');
    const server = createServer((req, res) => this.refusePlainHttp(req, res));
    server.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleConnect(req, socket, head);
    });
    server.on('clientError', (_err, socket) => {
      socket.destroy();
    });
    server.maxHeadersCount = 64;
    this.server = server;
    const listen = this.options.listen;
    if (listen.kind === 'unix') {
      rmSync(listen.path, { force: true });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(listen.path, () => {
          server.off('error', reject);
          resolve();
        });
      });
      chmodSync(listen.path, 0o600);
      this.socketPath = listen.path;
      return { kind: 'unix', path: listen.path };
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('[sandbox] egress proxy has no TCP address');
    return { kind: 'tcp', port: address.port };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.socketPath) rmSync(this.socketPath, { force: true });
  }

  private record(host: string, port: number, allowed: boolean, reason: string): void {
    const decision: ProxyDecision = { at: new Date().toISOString(), host, port, allowed, reason };
    if (allowed) this.allowedCount += 1;
    else this.deniedCount += 1;
    this.decisionLog.push(decision);
    if (this.decisionLog.length > MAX_DECISIONS) this.decisionLog.shift();
    this.options.onDecision?.(decision);
  }

  private refusePlainHttp(req: IncomingMessage, res: ServerResponse): void {
    const target = parseConnectTarget(req.headers.host);
    this.record(target?.host ?? 'unknown', target?.port ?? 0, false, 'plain-http-refused');
    res.writeHead(403, { 'content-type': 'text/plain', 'x-proxy-error': 'blocked-by-openlinear-sandbox', connection: 'close' });
    res.end('OpenLinear sandbox: only HTTPS (CONNECT) egress to allowlisted hosts is permitted\n');
  }

  private deny(socket: Duplex, host: string, port: number, reason: string): void {
    this.record(host, port, false, reason);
    const body = `OpenLinear sandbox blocked ${host}:${port} (${reason})\n`;
    socket.end(
      `HTTP/1.1 403 Forbidden\r\nX-Proxy-Error: blocked-by-openlinear-sandbox\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  }

  private async handleConnect(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => socket.destroy());
    const target = parseConnectTarget(req.url);
    if (!target) {
      this.deny(socket, 'invalid', 0, 'malformed-connect-target');
      return;
    }
    if (this.sockets.size >= this.maxConnections) {
      this.deny(socket, target.host, target.port, 'too-many-connections');
      return;
    }
    const rule = matchRule(this.rules, target.host, target.port);
    if (!rule) {
      this.deny(socket, target.host, target.port, 'not-allowlisted');
      return;
    }
    let address: string;
    if (isIP(target.host) !== 0) {
      // Only reachable when the literal itself is allowlisted, and never a
      // host-local class unless this proxy explicitly allows it.
      const denied = this.options.allowLocalTargets ? null : deniedAddressClass(target.host);
      if (denied) {
        this.deny(socket, target.host, target.port, `denied-address-${denied}`);
        return;
      }
      address = target.host;
    } else {
      let addresses: string[];
      try {
        addresses = await this.resolve(target.host);
      } catch {
        this.deny(socket, target.host, target.port, 'dns-failure');
        return;
      }
      const usable = addresses.find((candidate) => deniedAddressClass(candidate) === null);
      if (!usable) {
        this.deny(socket, target.host, target.port, `resolved-to-${addresses.map(deniedAddressClass).find(Boolean) ?? 'nothing'}`);
        return;
      }
      address = usable;
    }
    const upstream: Socket = connect({ host: address, port: target.port });
    this.sockets.add(socket);
    this.sockets.add(upstream);
    const untrack = () => {
      this.sockets.delete(socket);
      this.sockets.delete(upstream);
    };
    const destroyBoth = () => {
      untrack();
      socket.destroy();
      upstream.destroy();
    };
    let connected = false;
    upstream.setTimeout(this.idleTimeoutMs, destroyBoth);
    upstream.once('error', () => {
      if (!connected) {
        this.record(target.host, target.port, false, 'upstream-unreachable');
        if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        untrack();
        upstream.destroy();
        return;
      }
      destroyBoth();
    });
    upstream.once('connect', () => {
      connected = true;
      this.record(target.host, target.port, true, rule.ipLiteral ? 'allowlisted-ip' : 'allowlisted-host');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      // pipe() propagates end-of-stream in both directions, so buffered
      // data is flushed before each side is closed.
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    // The agent went away: nothing left to deliver upstream.
    socket.once('close', () => {
      untrack();
      upstream.destroy();
    });
    upstream.once('close', () => {
      untrack();
      if (socket.writable) socket.end();
    });
  }
}
