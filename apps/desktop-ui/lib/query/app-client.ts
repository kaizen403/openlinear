import type { QueryClient } from "@tanstack/react-query"

/*
 * The mounted app QueryClient, for the few module-level helpers that predate
 * hooks (e.g. `invalidateLabelCache`). Components use `useAppQueryClient()`.
 */
let appClient: QueryClient | null = null

export function setAppQueryClient(client: QueryClient | null): void {
  appClient = client
}

export function getAppQueryClient(): QueryClient | null {
  return appClient
}
