import { ApiError } from "./fetch"

export interface ModelNotConfiguredInfo {
  message: string
  hasProvider: boolean
}

export function isModelNotConfiguredApiError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === "MODEL_NOT_CONFIGURED"
}

export function readModelNotConfiguredDetails(err: ApiError): ModelNotConfiguredInfo {
  const details = err.details as { hasProvider?: unknown } | undefined
  const hasProvider = typeof details?.hasProvider === "boolean" ? details.hasProvider : false
  return { message: err.message, hasProvider }
}
