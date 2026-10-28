import { createServer, type Server } from 'node:http';
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as V1Transport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { WorkerConfig } from '../src/config';
import { createWorker, type OpenLinearWorker, type WorkerDependencies } from '../src/worker';
import { FakeOpenLinearApi } from './fake-api';

/**
 * In-process harness: the fake OpenLinear API and the MCP worker each listen
 * on 127.0.0.1 with an ephemeral port, and real MCP clients talk to the
 * worker over HTTP.
 */
export interface Harness {
  api: FakeOpenLinearApi;
  worker: OpenLinearWorker;
  mcpUrl: string;
  origin: string;
  /** Background work started with waitUntil (usage logging). */
  settle(): Promise<void>;
  stop(): Promise<void>;
}

export async function startHarness(
  options: { config?: Partial<WorkerConfig>; deps?: WorkerDependencies } = {},
): Promise<Harness> {
  const api = new FakeOpenLinearApi();
  const apiUrl = await api.start();
  const worker = createWorker(
    {
      apiUrl,
      allowedOrigins: [],
      authorizationServers: [],
      docsUrl: 'https://docs.example.test/mcp',
      ...options.config,
    },
    { sleep: async () => {}, ...options.deps },
  );
  const pending: Array<Promise<unknown>> = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      }
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const method = req.method ?? 'GET';
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
        signal: controller.signal,
      });
      const response = await worker.fetch(request, (promise) => {
        pending.push(promise);
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('worker did not bind a TCP port');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    api,
    worker,
    mcpUrl: `${origin}/mcp`,
    origin,
    async settle() {
      while (pending.length > 0) await Promise.allSettled(pending.splice(0));
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await api.stop();
    },
  };
}

export type ClientKind = 'v1-legacy' | 'v2-legacy' | 'v2-modern';
export const CLIENT_KINDS: readonly ClientKind[] = ['v1-legacy', 'v2-legacy', 'v2-modern'];

export interface ToolCallOutcome {
  isError: boolean;
  text: string;
  structured: unknown;
}

export interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface TestClient {
  kind: ClientKind;
  protocolVersion: string | undefined;
  serverName: string | undefined;
  instructions: string | undefined;
  listTools(): Promise<ListedTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  close(): Promise<void>;
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block) {
      return typeof block.text === 'string' ? block.text : '';
    }
  }
  return '';
}

/**
 * - `v1-legacy`: `@modelcontextprotocol/sdk` 1.32.2, the client most deployed
 *   MCP hosts embed (2025-11-25 initialize handshake, output validated with Ajv).
 * - `v2-legacy`: `@modelcontextprotocol/client` 2.4.0 in its default mode
 *   (byte-identical 2025 handshake).
 * - `v2-modern`: the same client pinned to the stateless 2026-07-28 revision.
 */
export async function connectClient(kind: ClientKind, mcpUrl: string, token: string): Promise<TestClient> {
  const requestInit = { headers: { Authorization: `Bearer ${token}` } };
  if (kind === 'v1-legacy') {
    const client = new V1Client({ name: 'openlinear-mcp-tests', version: '1.0.0' });
    const transport = new V1Transport(new URL(mcpUrl), { requestInit });
    await client.connect(transport);
    return {
      kind,
      protocolVersion: transport.protocolVersion,
      serverName: client.getServerVersion()?.name,
      instructions: client.getInstructions(),
      async listTools() {
        const { tools } = await client.listTools();
        return tools.map((tool) => ({ ...tool, annotations: tool.annotations }));
      },
      async call(name, args) {
        const result = await client.callTool({ name, arguments: args });
        return { isError: result.isError === true, text: firstText(result.content), structured: result.structuredContent };
      },
      close: () => client.close(),
    };
  }
  const client = new ModernClient(
    { name: 'openlinear-mcp-tests', version: '2.0.0' },
    kind === 'v2-modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(new ModernTransport(new URL(mcpUrl), { requestInit }));
  return {
    kind,
    protocolVersion: client.getNegotiatedProtocolVersion(),
    serverName: client.getServerVersion()?.name,
    instructions: client.getInstructions(),
    async listTools() {
      const { tools } = await client.listTools();
      return tools;
    },
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, text: firstText(result.content), structured: result.structuredContent };
    },
    close: () => client.close(),
  };
}

/** A user with one workspace and one project (with its default team and labels). */
export function seedBasics(api: FakeOpenLinearApi) {
  const alice = api.addUser('alice');
  const bob = api.addUser('bob');
  const workspace = api.addWorkspace('Acme', { [alice.id]: 'owner', [bob.id]: 'member' });
  const { project, team } = api.addProject(workspace.id, alice.id, 'Auth Revamp', 'AUTH');
  team.members.set(bob.id, 'member');
  const token = api.addPat(alice.id, { scopes: ['write'] });
  return { alice, bob, workspace, project, team, token };
}
