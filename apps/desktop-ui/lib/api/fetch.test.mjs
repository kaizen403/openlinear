import { describe, it, expect, vi, beforeEach } from "vitest"

const { apiFetch, ApiError, AuthExpiredError, NetworkError } = await import("./fetch.ts")

describe("apiFetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
    localStorage.clear()
  })

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
