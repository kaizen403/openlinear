/**
 * Single accessor for the auth JWT — every read/write in the app should go
 * through here rather than touching `localStorage` (or a Tauri store)
 * directly, so the storage mechanism can change in one place.
 *
 * - Web build: backed by `localStorage`, same as before.
 * - Desktop (Tauri) build: backed by `@tauri-apps/plugin-store`, which
 *   persists outside the webview's `localStorage` — a plain browser-storage
 *   read (devtools, a compromised extension, another local process poking at
 *   the webview's storage files) no longer hands over the session token.
 *   A synchronous in-memory cache mirrors the persisted value so existing
 *   synchronous call sites (`getToken()`) keep working; `initTokenStore()`
 *   must be awaited once at startup to hydrate it from disk.
 *
 * Follow-up (Phase 1): replace this accessor's internals with an
 * httpOnly-cookie-backed session. Because everything funnels through
 * `getToken`/`setToken`, that's a one-file change.
 */

const TOKEN_KEY = "token"
const STORE_FILE = "auth.json"

let memoryToken: string | null = null
let hydrated = false
let tauriStorePromise: Promise<import("@tauri-apps/plugin-store").Store> | null = null

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

function readLocalStorage(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function writeLocalStorage(token: string | null) {
  if (typeof window === "undefined") return
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token)
    else window.localStorage.removeItem(TOKEN_KEY)
  } catch {}
}

async function getTauriStore() {
  if (!tauriStorePromise) {
    tauriStorePromise = import("@tauri-apps/plugin-store").then(({ Store }) => Store.load(STORE_FILE))
  }
  return tauriStorePromise
}

/**
 * Hydrates the in-memory cache from durable storage. Must be awaited once,
 * early (e.g. from `AuthProvider`'s startup effect), before anything reads
 * the token on desktop. Safe to call more than once — later calls are no-ops.
 */
export async function initTokenStore(): Promise<void> {
  if (hydrated) return
  if (!isTauriRuntime()) {
    memoryToken = readLocalStorage()
    hydrated = true
    return
  }
  try {
    const store = await getTauriStore()
    const stored = await store.get<string>(TOKEN_KEY)
    if (stored) {
      memoryToken = stored
    } else {
      // One-time migration for desktop users who already had a token sitting
      // in localStorage from before this store existed.
      const legacy = readLocalStorage()
      if (legacy) {
        memoryToken = legacy
        await store.set(TOKEN_KEY, legacy)
        await store.save()
      }
    }
    // Desktop no longer keeps the token in localStorage once the store is live.
    writeLocalStorage(null)
  } catch {
    // Tauri store unavailable for some reason — fall back to localStorage
    // rather than forcing a logout.
    memoryToken = readLocalStorage()
  } finally {
    hydrated = true
  }
}

/** Synchronous read — single point of truth for token reads app-wide. */
export function getToken(): string | null {
  if (hydrated) return memoryToken
  // Not hydrated yet (very early boot, or a caller that never awaited
  // initTokenStore(), e.g. in tests): fall back to localStorage so nothing
  // regresses before initTokenStore() resolves.
  return readLocalStorage()
}

/** Writes (or clears, when `token` is null) the token everywhere it's stored. */
export function setToken(token: string | null): void {
  memoryToken = token
  hydrated = true
  if (isTauriRuntime()) {
    void getTauriStore()
      .then(async (store) => {
        if (token) await store.set(TOKEN_KEY, token)
        else await store.delete(TOKEN_KEY)
        await store.save()
      })
      .catch(() => {})
    // Defensive: never let a stray copy linger in localStorage on desktop.
    writeLocalStorage(null)
  } else {
    writeLocalStorage(token)
  }
}
