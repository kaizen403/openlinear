import { prisma } from '@openlinear/db';
import type { GitHubUser } from './github';

/**
 * DEPRECATED: User accessToken storage in database
 * 
 * This module is being migrated to local-only storage.
 * GitHub tokens should be stored in desktop secure storage, not cloud DB.
 * 
 * Migration status:
 * - WRITES: Disabled (accessToken no longer stored in DB)
 * - READS: Still available for backward compatibility during transition
 * - TARGET: Complete removal in future release
 * 
 * @see docs/security/trust-boundary.md
 */

const DEPRECATION_WARNING = 
'WARNING: Storing accessToken in database is deprecated. ' +
'Read docs/security/trust-boundary.md for migration guide.';

/**
 * Create or update user WITHOUT storing accessToken
 * Token should be stored in desktop secure storage
 */
export async function createOrUpdateUserWithoutToken(
  githubUser: GitHubUser
) {
  console.warn(DEPRECATION_WARNING);
  
  return prisma.user.upsert({
    where: { githubId: githubUser.id },
    update: {
      username: githubUser.login,
      email: githubUser.email,
      avatarUrl: githubUser.avatar_url,
    },
    create: {
      githubId: githubUser.id,
      username: githubUser.login,
      email: githubUser.email,
      avatarUrl: githubUser.avatar_url,
    },
  });
}

/**
 * Connect GitHub account WITHOUT storing accessToken
 * Token should be stored in desktop secure storage
 */
export async function connectGitHubWithoutToken(
  userId: string,
  githubUser: GitHubUser
) {
  console.warn(DEPRECATION_WARNING);
  
  const existingGitHubUser = await prisma.user.findUnique({
    where: { githubId: githubUser.id },
  });

  if (existingGitHubUser && existingGitHubUser.id !== userId) {
    throw new Error('This GitHub account is already linked to another user');
  }

  return prisma.user.update({
    where: { id: userId },
    data: {
      githubId: githubUser.id,
      avatarUrl: githubUser.avatar_url,
    },
  });
}

/**
 * Check if user has a legacy stored token
 * Used during migration to identify users who need to transition
 */
export async function hasLegacyStoredToken(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { accessToken: true },
  });
  return !!user?.accessToken;
}

/**
 * Migration helper: Clear legacy token from DB
 * Call after token is migrated to local storage
 */
export async function clearLegacyToken(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { accessToken: null },
  });
}

/**
 * Get legacy token (for backward compatibility during transition)
 * @deprecated Tokens should come from local secure storage
 */
export async function getLegacyToken(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { accessToken: true },
  });
  return user?.accessToken ?? null;
}
