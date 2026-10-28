import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const invoke = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args) => invoke(...args) }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }))

const { apiFetch, apiFetchRaw, refreshAccessToken, ApiError, AuthExpiredError, NetworkError } = await import("./fetch.ts")
const client = await import("./client.ts")
const tokenStore = await import("./token-store.ts")

const CLOUD = "https://cloud.example.test"
const SIDECAR = "http://127.0.0.1:4199"
const ENV_KEYS = ["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_CLOUD_API_URL", "NEXT_PUBLIC_SIDECAR_URL"]
const savedEnv = {}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function authHeaderOf(call) {
  const headers = call[1]?.headers
  if (!headers) return null
  return headers instanceof Headers ? headers.get("Authorization") : headers.Authorization ?? null
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  process.env.NEXT_PUBLIC_API_URL = CLOUD
  process.env.NEXT_PUBLIC_SIDECAR_URL = SIDECAR
  delete process.env.NEXT_PUBLIC_CLOUD_API_URL
  window.__TAURI_INTERNALS__ = undefined
  invoke.mockReset()
  invoke.mockResolvedValue(null)
  client.resetSidecarUrlCacheForTests()
  tokenStore.resetTokenStoreForTests()
  vi.stubGlobal("fetch", vi.fn())
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.__TAURI_INTERNALS__ = undefined
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe("apiFetch", () => {
  it("makes a GET request with default headers", async () => {
    const mockResponse = { ok: true, status: 200, json: async () => ({ data: "test" }), headers: new Headers({ "content-type": "application/json" }) }
    globalThis.fetch.mockResolvedValue(mockResponse)

    const result = await apiFetch("/api/test")
    expect(result).toEqual({ data: "test" })
    const [url, init] = globalThis.fetch.mock.calls[0]
    expect(url).toContain("/api/test")
    expect(init.headers).toBeInstanceOf(Headers)
  })

  it("throws ApiError on non-ok response", async () => {
    const mockResponse = {
      ok: false,
      status: 422,
      statusText: "Unprocessable",
      json: async () => ({ error: "Bad", code: "VALIDATION_ERROR" }),
      headers: new Headers(),
      clone: () => mockResponse,
    }
    globalThis.fetch.mockResolvedValue(mockResponse)

    try {
      await apiFetch("/api/test")
      expect.fail("should throw")
    } catch (err) {
      expect(err.status).toBe(422)
      expect(err.code).toBe("VALIDATION_ERROR")
    }
  })

  it("reads the nested API error envelope", async () => {
    globalThis.fetch.mockResolvedValue(json(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "Key reused" } }))
    await expect(apiFetch("/api/tasks", { method: "POST", body: "{}" })).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      message: "Key reused",
    })
  })

  it("throws NetworkError on fetch failure", async () => {
    globalThis.fetch.mockRejectedValue(new Error("Connection refused"))

    try {
      await apiFetch("/api/test")
      expect.fail("should throw")
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError)
    }
  })

  it("passes through AbortError", async () => {
    const abortErr = new DOMException("Aborted", "AbortError")
    globalThis.fetch.mockRejectedValue(abortErr)

    try {
      await apiFetch("/api/test")
      expect.fail("should throw")
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException)
    }
  })

  it("returns undefined on 204 No Content", async () => {
    const mockResponse = { ok: true, status: 204, headers: new Headers(), text: async () => "" }
    globalThis.fetch.mockResolvedValue(mockResponse)

    const result = await apiFetch("/api/test")
    expect(result).toBeUndefined()
  })

  it("throws AuthExpiredError on 401", async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      json: async () => ({ error: "Session expired" }),
      headers: new Headers(),
      clone: () => mockResponse,
    }
    globalThis.fetch.mockResolvedValue(mockResponse)

    try {
      await apiFetch("/api/test")
      expect.fail("should throw")
    } catch (err) {
      expect(err).toBeInstanceOf(AuthExpiredError)
    }
  })
})

describe("routing", () => {
  it("sends execution routes to the sidecar and the rest to the cloud API", async () => {
    globalThis.fetch.mockImplementation(async () => json(200, {}))
    await apiFetch("/api/tasks/t1/execute", { method: "POST" })
    await apiFetch("/api/tasks/t1", { method: "PATCH", body: "{}" })
    expect(globalThis.fetch.mock.calls.map(([url]) => url)).toEqual([
      `${SIDECAR}/api/tasks/t1/execute`,
      `${CLOUD}/api/tasks/t1`,
    ])
  })

  it("lets the route table win over a contradicting sidecar flag", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    globalThis.fetch.mockImplementation(async () => json(200, {}))
    await apiFetch("/api/projects", { sidecar: true })
    expect(globalThis.fetch.mock.calls[0][0]).toBe(`${CLOUD}/api/projects`)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("waits for the Tauri-reported port before calling the desktop sidecar", async () => {
    window.__TAURI_INTERNALS__ = {}
    invoke.mockImplementation(async (command) => (command === "get_api_server_port" ? 45123 : null))
    globalThis.fetch.mockImplementation(async () => json(200, {}))
    await apiFetchRaw("/api/opencode/models")
    expect(globalThis.fetch.mock.calls[0][0]).toBe("http://127.0.0.1:45123/api/opencode/models")
  })
})

describe("token refresh (web: HttpOnly cookie)", () => {
  it("refreshes at the cloud API with the cookie and retries once", async () => {
    localStorage.setItem("token", "expired-token")
    globalThis.fetch
      .mockResolvedValueOnce(json(401, { error: "expired" }))
      .mockResolvedValueOnce(json(200, { token: "fresh-token" }))
      .mockResolvedValueOnce(json(200, { ok: true }))

    await expect(apiFetch("/api/projects")).resolves.toEqual({ ok: true })

    const [refreshUrl, refreshInit] = globalThis.fetch.mock.calls[1]
    expect(refreshUrl).toBe(`${CLOUD}/api/auth/refresh`)
    expect(refreshInit.credentials).toBe("include")
    expect(JSON.parse(refreshInit.body)).toEqual({})
    expect(authHeaderOf(globalThis.fetch.mock.calls[2])).toBe("Bearer fresh-token")
    expect(localStorage.getItem("token")).toBe("fresh-token")
    expect(localStorage.getItem("refreshToken")).toBeNull()
  })

  it("never stores a refresh token returned to the web build", async () => {
    localStorage.setItem("token", "expired-token")
    globalThis.fetch
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { token: "fresh-token", refreshToken: "should-not-be-stored" }))
      .mockResolvedValueOnce(json(200, {}))
    await apiFetch("/api/projects")
    expect(localStorage.getItem("refreshToken")).toBeNull()
    expect(tokenStore.getRefreshToken()).toBeNull()
  })

  it("signs out when the refresh fails", async () => {
    localStorage.setItem("token", "expired-token")
    const onExpired = vi.fn()
    window.addEventListener("auth:expired", onExpired)
    globalThis.fetch
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(401, { code: "INVALID_REFRESH" }))

    await expect(apiFetch("/api/projects")).rejects.toBeInstanceOf(AuthExpiredError)
    expect(onExpired).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem("token")).toBeNull()
    window.removeEventListener("auth:expired", onExpired)
  })

  it("shares one refresh between concurrent 401s", async () => {
    localStorage.setItem("token", "expired-token")
    let refreshCalls = 0
    globalThis.fetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/api/auth/refresh")) {
        refreshCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return json(200, { token: "fresh-token" })
      }
      const auth = init.headers.get("Authorization")
      return auth === "Bearer fresh-token" ? json(200, { ok: true }) : json(401, {})
    })

    const results = await Promise.all([apiFetch("/api/a"), apiFetch("/api/b"), apiFetch("/api/c")])
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }])
    expect(refreshCalls).toBe(1)
  })

  it("does not refresh anonymous requests", async () => {
    globalThis.fetch.mockResolvedValueOnce(json(401, {}))
    await expect(apiFetch("/api/projects")).rejects.toBeInstanceOf(AuthExpiredError)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it("refreshes against the cloud even when a sidecar call failed, and retries the sidecar", async () => {
    localStorage.setItem("token", "expired-token")
    globalThis.fetch
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { token: "fresh-token" }))
      .mockResolvedValueOnce(json(202, { accepted: true }))
    await expect(apiFetch("/api/tasks/t1/execute", { method: "POST" })).resolves.toEqual({ accepted: true })
    expect(globalThis.fetch.mock.calls.map(([url]) => url)).toEqual([
      `${SIDECAR}/api/tasks/t1/execute`,
      `${CLOUD}/api/auth/refresh`,
      `${SIDECAR}/api/tasks/t1/execute`,
    ])
  })

  it("does not sign the user out when only the sidecar still refuses the token", async () => {
    localStorage.setItem("token", "expired-token")
    const onExpired = vi.fn()
    window.addEventListener("auth:expired", onExpired)
    globalThis.fetch
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { token: "fresh-token" }))
      .mockResolvedValueOnce(json(401, { code: "INVALID_TOKEN", error: "Invalid token" }))

    const err = await apiFetch("/api/batches").catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).not.toBeInstanceOf(AuthExpiredError)
    expect(err.status).toBe(401)
    expect(onExpired).not.toHaveBeenCalled()
    expect(localStorage.getItem("token")).toBe("fresh-token")
    window.removeEventListener("auth:expired", onExpired)
  })
})

describe("token refresh (desktop: stored refresh token)", () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {}
    process.env.NEXT_PUBLIC_CLOUD_API_URL = CLOUD
  })

  it("posts the stored refresh token to the cloud API and stores the rotated one", async () => {
    tokenStore.setToken("expired-token")
    tokenStore.setRefreshToken("refresh-1")
    globalThis.fetch.mockResolvedValueOnce(json(200, { token: "fresh-token", refreshToken: "refresh-2" }))

    await expect(refreshAccessToken()).resolves.toBe(true)
    const [url, init] = globalThis.fetch.mock.calls[0]
    expect(url).toBe(`${CLOUD}/api/auth/refresh`)
    expect(init.credentials).toBe("omit")
    expect(JSON.parse(init.body)).toEqual({ refreshToken: "refresh-1" })
    expect(tokenStore.getToken()).toBe("fresh-token")
    expect(tokenStore.getRefreshToken()).toBe("refresh-2")
    expect(localStorage.getItem("refreshToken")).toBeNull()
  })

  it("skips the network when no refresh token is stored", async () => {
    await expect(refreshAccessToken()).resolves.toBe(false)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it("drops a refresh token the API rejects", async () => {
    tokenStore.setRefreshToken("revoked")
    globalThis.fetch.mockResolvedValueOnce(json(401, { code: "INVALID_REFRESH" }))
    await expect(refreshAccessToken()).resolves.toBe(false)
    expect(tokenStore.getRefreshToken()).toBeNull()
  })
})

describe("explicit and anonymous credentials", () => {
  it("anonymous requests carry no bearer token", async () => {
    localStorage.setItem("token", "stored-token")
    globalThis.fetch.mockResolvedValueOnce(json(200, {}))
    await apiFetch("/api/auth/providers", { anonymous: true })
    expect(authHeaderOf(globalThis.fetch.mock.calls[0])).toBeNull()
  })

  it("authToken overrides the stored token and never refreshes or stores", async () => {
    localStorage.setItem("token", "stored-token")
    globalThis.fetch.mockResolvedValueOnce(json(401, { error: "Invalid token" }))
    const err = await apiFetch("/api/auth/me", { authToken: "candidate" }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).not.toBeInstanceOf(AuthExpiredError)
    expect(authHeaderOf(globalThis.fetch.mock.calls[0])).toBe("Bearer candidate")
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem("token")).toBe("stored-token")
  })
})

describe("ApiError classes", () => {
  it("ApiError carries status, message, code, details", () => {
    const err = new ApiError(400, "Bad Request", "bad", { field: "name" })
    expect(err.status).toBe(400)
    expect(err.message).toBe("Bad Request")
    expect(err.code).toBe("bad")
    expect(err.details).toEqual({ field: "name" })
  })

  it("AuthExpiredError has 401 status and auth_expired code", () => {
    const err = new AuthExpiredError("Expired")
    expect(err.status).toBe(401)
    expect(err.code).toBe("auth_expired")
  })

  it("NetworkError has retryAfterMs", () => {
    const err = new NetworkError("Offline", 2000)
    expect(err.message).toBe("Offline")
    expect(err.retryAfterMs).toBe(2000)
  })
})
