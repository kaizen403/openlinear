/**
 * True inside the Tauri desktop shell, which injects `window.__TAURI_INTERNALS__`.
 *
 * Checks the value, not just the key: a key that exists but is empty (as in
 * the unit-test setup) means "not Tauri".
 */
export function isDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}
