/** Closed PAT scope enum. `*` is rejected on create; existing rows may still have it. */
export const PAT_SCOPES = [
  "read",
  "write",
  "tasks:read",
  "tasks:write",
  "projects:read",
  "projects:write",
  "workspaces:read",
  "labels:write",
  "admin",
] as const;

export type PatScope = (typeof PAT_SCOPES)[number];

export const PAT_SCOPE_SET = new Set<string>(PAT_SCOPES);

export function isPatScope(value: string): value is PatScope {
  return PAT_SCOPE_SET.has(value);
}

export function writeImpliesRead(scopes: readonly string[]): boolean {
  return scopes.some(
    (scope) =>
      scope === "*" ||
      scope === "admin" ||
      scope === "write" ||
      scope.endsWith(":write"),
  );
}

function grantsAll(scopes: readonly string[]): boolean {
  return scopes.includes("*") || scopes.includes("admin");
}

/**
 * Closed-enum PAT matching. `write` and `*:write` imply the matching read
 * scope. A resource-specific write also satisfies the generic `write` check
 * used as the default for mutating routes that did not declare a narrower
 * scope.
 */
export function hasRequiredScopes(scopes: readonly string[], requiredScopes: readonly string[]): boolean {
  if (requiredScopes.length === 0) return true;
  if (grantsAll(scopes)) return true;

  return requiredScopes.every((required) => scopeSatisfies(scopes, required));
}

function scopeSatisfies(scopes: readonly string[], required: string): boolean {
  if (scopes.includes(required)) return true;
  if (scopes.includes("write") && required !== "admin") return true;
  if (required === "read") {
    return writeImpliesRead(scopes) || scopes.some((scope) => scope.endsWith(":read"));
  }
  if (required === "write") {
    return scopes.some((scope) => scope === "write" || scope.endsWith(":write"));
  }
  if (required.endsWith(":read")) {
    const resource = required.slice(0, -":read".length);
    return scopes.includes("read") || scopes.includes(`${resource}:write`);
  }
  return false;
}

/** Default PAT scope when a route used bare `requireAuth`. */
export function defaultPatScopesForMethod(method: string): string[] {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") return ["read"];
  return ["write"];
}
