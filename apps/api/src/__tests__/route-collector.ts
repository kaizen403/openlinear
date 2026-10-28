/**
 * Enumerate the routes `createApp()` actually registers.
 *
 * Express 5 (router@2) does not keep mount paths on its layers, so mounts are
 * recorded by wrapping `app.use` / `router.use` while the app is built, then
 * the layer tree is walked. Used by the route-inventory parity test.
 */
import express, { type Application } from 'express';

type Handler = (...args: unknown[]) => unknown;

interface RouterLayer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle: Handler & { stack?: RouterLayer[] };
}

interface UseHost {
  use: (...args: unknown[]) => unknown;
}

function isRouter(value: unknown): value is Handler & { stack: RouterLayer[] } {
  return typeof value === 'function' && Array.isArray((value as { stack?: unknown }).stack);
}

export interface RegisteredRoute {
  method: string;
  path: string;
}

export function collectRegisteredRoutes(build: () => Application): RegisteredRoute[] {
  const mounts = new Map<Handler, string[]>();
  const record = (args: unknown[]) => {
    const [path, ...handlers] = args;
    if (typeof path !== 'string') return;
    for (const handler of handlers.flat()) {
      if (!isRouter(handler)) continue;
      const paths = mounts.get(handler) ?? [];
      paths.push(path);
      mounts.set(handler, paths);
    }
  };

  const appProto = express.application as unknown as UseHost;
  const routerProto = Object.getPrototypeOf(express.Router()) as UseHost;
  const originalAppUse = appProto.use;
  const originalRouterUse = routerProto.use;
  appProto.use = function patchedAppUse(this: unknown, ...args: unknown[]) {
    record(args);
    return originalAppUse.apply(this, args);
  };
  routerProto.use = function patchedRouterUse(this: unknown, ...args: unknown[]) {
    record(args);
    return originalRouterUse.apply(this, args);
  };

  let app: Application;
  try {
    app = build();
  } finally {
    appProto.use = originalAppUse;
    routerProto.use = originalRouterUse;
  }

  const routes = new Map<string, RegisteredRoute>();
  const walk = (stack: RouterLayer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const path of paths) {
          for (const method of Object.keys(layer.route.methods)) {
            if (method === '_all') continue;
            const full = `${prefix}${path}`.replace(/\/$/, '') || '/';
            const upper = method.toUpperCase();
            routes.set(`${upper} ${full}`, { method: upper, path: full });
          }
        }
      } else if (isRouter(layer.handle)) {
        const mountPaths = mounts.get(layer.handle);
        if (!mountPaths) {
          throw new Error('Found a mounted router whose mount path was not recorded');
        }
        for (const mountPath of mountPaths) {
          walk(layer.handle.stack, prefix + (mountPath === '/' ? '' : mountPath));
        }
      }
    }
  };
  const root = (app as unknown as { router: { stack: RouterLayer[] } }).router;
  walk(root.stack, '');
  return [...routes.values()];
}
