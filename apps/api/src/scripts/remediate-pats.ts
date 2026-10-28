/**
 * One-off PAT remediation (W02b). See services/pat-remediation.ts.
 *
 *   pnpm --filter @openlinear/api exec tsx src/scripts/remediate-pats.ts            # dry run
 *   pnpm --filter @openlinear/api exec tsx src/scripts/remediate-pats.ts --apply    # write
 *
 * Options:
 *   --apply                  write changes (default: dry run, report only)
 *   --revoke-wildcard        revoke legacy `*` tokens instead of setting an expiry
 *   --sunset-days=<n>        days until legacy `*` tokens expire (default 30)
 *   --created-before=<iso>   cut-off for the "unclassified account-wide" count
 *                            (use the W02a deploy time)
 *   --user=<id>              only tokens owned by this user (repeatable)
 *
 * Reads DATABASE_URL. Prints a JSON report of token ids (never token values;
 * only hashes are stored). Writes are idempotent and audited.
 */
import { prisma } from '@openlinear/db';
import { remediatePersonalAccessTokens, type PatRemediationOptions } from '../services/pat-remediation';

function parseArgs(argv: string[]): PatRemediationOptions {
  const options: PatRemediationOptions = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--revoke-wildcard') options.revokeWildcard = true;
    else if (arg.startsWith('--sunset-days=')) options.wildcardSunsetDays = Number(arg.slice('--sunset-days='.length));
    else if (arg.startsWith('--created-before=')) {
      const value = new Date(arg.slice('--created-before='.length));
      if (Number.isNaN(value.getTime())) throw new Error(`Invalid --created-before: ${arg}`);
      options.createdBefore = value;
    } else if (arg.startsWith('--user=')) {
      options.userIds = [...(options.userIds ?? []), arg.slice('--user='.length)];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function describeTarget(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set');
  const url = new URL(raw);
  return `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  process.stderr.write(`[remediate-pats] target ${describeTarget()} (${options.apply ? 'APPLY' : 'dry run'})\n`);
  const report = await remediatePersonalAccessTokens(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`[remediate-pats] failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
