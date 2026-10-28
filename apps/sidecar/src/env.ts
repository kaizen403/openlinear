import { CLOUD_API_URL_ENV, configureCloudApiFromEnv } from './config/cloud-api';
import { logger } from './lib/logger';
import { shouldUsePrisma } from './persistence/boot';

/**
 * Cloud-only secrets the sidecar must never hold (W03a). In API-only mode
 * they are removed from the process environment at boot so no subprocess
 * (git, OpenCode, tools) can inherit them, even if an old launcher passes
 * them. Prisma (test / --with-cloud-api) mode keeps them for local decrypts.
 */
export const CLOUD_ONLY_SECRETS = ['JWT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'GITHUB_CLIENT_SECRET'] as const;

export interface SidecarEnvReport {
  cloudApiConfigured: boolean;
  scrubbed: string[];
}

export function validateSidecarEnv(env: NodeJS.ProcessEnv = process.env, argv = process.argv): SidecarEnvReport {
  if (env.OPENLINEAR_TRUST_PROXY_AUTH !== undefined) {
    throw new Error('[Sidecar] OPENLINEAR_TRUST_PROXY_AUTH is no longer supported — remove it from your environment');
  }

  const cloudApi = configureCloudApiFromEnv(env);
  const scrubbed: string[] = [];
  if (!shouldUsePrisma(env, argv)) {
    for (const key of CLOUD_ONLY_SECRETS) {
      if (env[key] !== undefined) {
        delete env[key];
        scrubbed.push(key);
      }
    }
    if (scrubbed.length > 0) {
      logger.warn({ scrubbed }, '[Sidecar] removed cloud-only secrets from the environment; the sidecar never needs them');
    }
    if (!cloudApi) {
      logger.error(
        `[Sidecar] ${CLOUD_API_URL_ENV} is not set: callers cannot be authenticated and execution is refused (503 CLOUD_API_NOT_CONFIGURED)`,
      );
    }
  }
  return { cloudApiConfigured: Boolean(cloudApi), scrubbed };
}
