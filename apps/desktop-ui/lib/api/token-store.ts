/**
 * Single accessor for session credentials — every read/write in the app goes
 * through here rather than touching `localStorage` (or a Tauri store)
 * directly, so the storage mechanism can change in one place.
 *
 * | Credential           | Web build                                           | Desktop (Tauri) build                    |
 * |----------------------|-----------------------------------------------------|------------------------------------------|
 * | Access token (1 h)   | `localStorage` (unchanged)                          | `@tauri-apps/plugin-store` (`auth.json`) |
 * | Refresh token (30 d) | never in JS: the API's HttpOnly `ol_refresh` cookie | `@tauri-apps/plugin-store` (`auth.json`) |
 *
 * Web: the API sets `ol_refresh` (HttpOnly, SameSite=Lax, Path=/api/auth) when
 * sign-in completes, and POST /api/auth/refresh reads and rotates it, so page
 * script never sees the refresh token. Older builds kept a copy in
 * `localStorage`; it is deleted on startup.
 *
 * Desktop: the Tauri store keeps both tokens outside the webview's
 * `localStorage`. It is a file in the app-data directory, not the OS
 * keychain: a keychain needs a new Rust dependency (keyring/stronghold),
 * which is tracked separately. An in-memory cache mirrors the persisted
 * values so reads stay synchronous; `initTokenStore()` must be awaited once
 * at startup to load them.
 */

import { isDesktopRuntime } from "./runtime"

const TOKEN_KEY = "token"
const REFRESH_KEY = "refreshToken"
const STORE_FILE = "auth.json"

let memoryToken: string | null = null
let memoryRefresh: string | null = null
let hydrated = false
let hydrating: Promise<void> | null = null
// Any explicit write (before or while the store loads) wins over persisted values.
let tokenWrites = 0
let refreshWrites = 0
let tauriStorePromise: Promise<import("@tauri-apps/plugin-store").Store> | null = null

function readLocal(key: string): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocal(key: string, value: string | null) {
  if (typeof window === "undefined") return
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {}
}

async function getTauriStore() {
  if (!tauriStorePromise) {
    tauriStorePromise = import("@tauri-apps/plugin-store").then(({ Store }) => Store.load(STORE_FILE))
  }
  return tauriStorePromise
}

function persistToTauri(key: string, value: string | null) {
  void getTauriStore()
    .then(async (store) => {
      if (value) await store.set(key, value)
      else await store.delete(key)
      await store.save()
    })
    .catch(() => {})
}

async function hydrate(): Promise<void> {
  // A refresh token in web storage is readable by any script on the page.
  const legacyRefresh = readLocal(REFRESH_KEY)
  writeLocal(REFRESH_KEY, null)

  if (!isDesktopRuntime()) return

  try {
    const store = await getTauriStore()
    let storedToken = (await store.get<string>(TOKEN_KEY)) ?? null
    let storedRefresh = (await store.get<string>(REFRESH_KEY)) ?? null
    if (!storedToken) {
      // One-time migration for desktop users who had a token in localStorage
      // from before this store existed.
      const legacy = readLocal(TOKEN_KEY)
      if (legacy) {
        storedToken = legacy
        await store.set(TOKEN_KEY, legacy)
      }
    }
    if (!storedRefresh && legacyRefresh) {
      storedRefresh = legacyRefresh
      await store.set(REFRESH_KEY, legacyRefresh)
    }
    await store.save()
    if (tokenWrites === 0) memoryToken = storedToken
    if (refreshWrites === 0) memoryRefresh = storedRefresh
    // Desktop no longer keeps the token in localStorage once the store is live.
    writeLocal(TOKEN_KEY, null)
  } catch {
    // Tauri store unavailable for some reason — fall back to localStorage
    // for the access token rather than forcing a logout.
    if (tokenWrites === 0) memoryToken = readLocal(TOKEN_KEY)
    if (refreshWrites === 0) memoryRefresh = legacyRefresh
  }
}

/**
 * Loads persisted credentials. Must be awaited once, early (e.g. from
 * `AuthProvider`'s startup effect), before anything reads the tokens on
 * desktop. Safe to call more than once and concurrently.
 */
export async function initTokenStore(): Promise<void> {
  if (hydrated) return
  if (!hydrating) {
    hydrating = hydrate().finally(() => {
      hydrated = true
      hydrating = null
    })
  }
  return hydrating
}

/** Synchronous read — single point of truth for access-token reads app-wide. */
export function getToken(): string | null {
  // Web: localStorage is the store, so every tab sees a refreshed token.
  if (!isDesktopRuntime()) return readLocal(TOKEN_KEY)
  if (hydrated || tokenWrites > 0) return memoryToken
  // Not loaded yet (very early boot): a pre-store desktop build may still
  // have the token in localStorage.
  return readLocal(TOKEN_KEY)
}

/** Writes (or clears, when `token` is null) the access token. */
export function setToken(token: string | null): void {
  tokenWrites += 1
  memoryToken = token
  if (isDesktopRuntime()) {
    persistToTauri(TOKEN_KEY, token)
    // Defensive: never let a stray copy linger in localStorage on desktop.
    writeLocal(TOKEN_KEY, null)
  } else {
    writeLocal(TOKEN_KEY, token)
  }
}

/**
 * The refresh token held by this runtime. Always null on the web, where the
 * refresh token is an HttpOnly cookie that page script cannot read.
 */
export function getRefreshToken(): string | null {
  if (!isDesktopRuntime()) return null
  return memoryRefresh
}

/** Stores the refresh token (desktop only); on the web it only clears legacy copies. */
export function setRefreshToken(token: string | null): void {
  writeLocal(REFRESH_KEY, null)
  if (!isDesktopRuntime()) return
  refreshWrites += 1
  memoryRefresh = token
  persistToTauri(REFRESH_KEY, token)
}

/** Forget every credential this runtime holds. */
export function clearStoredSession(): void {
  setToken(null)
  setRefreshToken(null)
}

/** Test hook: reset the in-memory cache so the next read re-hydrates. */
export function resetTokenStoreForTests(): void {
  memoryToken = null
  memoryRefresh = null
  hydrated = false
  hydrating = null
  tokenWrites = 0
  refreshWrites = 0
  tauriStorePromise = null
}
