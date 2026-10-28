// Screenshot harness stand-in for `@/providers/sse-provider` (no event stream).
export function useSSESubscription() {}
export function useSSEStatus() {
  return { isConnected: true, isReconnecting: false }
}
