import { type Env, readConfig } from './config';
import { createWorker, type OpenLinearWorker } from './worker';

/**
 * Cloudflare Workers entry. The worker (and its token cache) lives for the
 * isolate's lifetime and is rebuilt only if the bound environment changes.
 */
let cached: { env: Env; worker: OpenLinearWorker } | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!cached || cached.env !== env) {
      try {
        cached = { env, worker: createWorker(readConfig(env)) };
      } catch (error) {
        console.error(
          JSON.stringify({ level: 'error', msg: 'invalid worker configuration', error: error instanceof Error ? error.message : String(error) }),
        );
        return Response.json({ error: 'server_misconfigured' }, { status: 500 });
      }
    }
    return cached.worker.fetch(request, (promise) => ctx.waitUntil(promise));
  },
} satisfies ExportedHandler<Env>;
