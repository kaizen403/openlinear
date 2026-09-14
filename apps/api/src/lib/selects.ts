export const userSelect = { id: true, username: true, email: true, avatarUrl: true } as const;

/**
 * Every field of `User` that may be returned to the authenticated user themself.
 *
 * This is an allowlist on purpose. `getUserById` previously used
 * `include: { repositories: true }` with no `select`, so `GET /api/auth/me`
 * returned `totpSecret` and `backupCodes` to any bearer of the user's token —
 * which made two-factor authentication decorative for anyone who could read one
 * response body. Adding a sensitive column to `User` must never silently widen a
 * response, so new fields have to be added here deliberately.
 *
 * `accessToken` is selected only so `githubLinked` can be derived; it is
 * stripped before serialization by `toCurrentUser`.
 */
export const currentUserSelect = {
  id: true,
  githubId: true,
  username: true,
  displayName: true,
  email: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
  totpEnabled: true,
  accessToken: true,
} as const;

type CurrentUserRow = {
  accessToken?: string | null;
  [key: string]: unknown;
};

/** Strip `accessToken` and expose only the derived `githubLinked` flag. */
export function toCurrentUser<T extends CurrentUserRow>(user: T) {
  const { accessToken, ...safe } = user;
  return { ...safe, githubLinked: Boolean(accessToken) };
}
