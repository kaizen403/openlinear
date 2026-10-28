import { useCallback, useEffect, useLayoutEffect, useRef } from "react"

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

/**
 * A function whose identity never changes but always runs the latest
 * implementation. Board event handlers use it so memoized columns and cards
 * don't re-render just because a parent render recreated a handler.
 * Only for event handlers: don't call the result during render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback)
  useIsomorphicLayoutEffect(() => {
    latest.current = callback
  })
  return useCallback((...args: Args) => latest.current(...args), [])
}
