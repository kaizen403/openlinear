export { AppError, HttpError, ValidationError, isAppError, mapPrismaError } from "./errors";
export { buildErrorEnvelope, type ErrorEnvelope } from "./envelope";
export { parseCursorPagination, paginated, type CursorPage, type OffsetPage } from "./pagination";
export { makeEtag } from "./etag";
export { TtlCache } from "./cache";
export { createLogger } from "./logger";
export {
  setTelemetryHooks,
  telemetry,
  RATE_LIMIT_POLICIES,
  type TelemetryHooks,
  type RateLimitPolicyName,
} from "./telemetry";
export {
  PAT_SCOPES,
  PAT_SCOPE_SET,
  isPatScope,
  writeImpliesRead,
  hasRequiredScopes,
  defaultPatScopesForMethod,
  type PatScope,
} from "./scopes";

export const JWT_ISSUER = "openlinear";
export const JWT_AUDIENCE = "openlinear-api";
export const ACCESS_TOKEN_TTL = "1h";
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
