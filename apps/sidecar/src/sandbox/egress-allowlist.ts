import { parseHostRule } from './egress-proxy';

/**
 * Default egress allowlist for an attempt: the model providers the user has
 * credentials/config for, plus package registries. Everything else is denied
 * by the per-attempt proxy. Ports default to 443.
 */
export const PROVIDER_HOSTS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['api.anthropic.com', 'console.anthropic.com'],
  openai: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
  google: ['generativelanguage.googleapis.com'],
  openrouter: ['openrouter.ai'],
  groq: ['api.groq.com'],
  mistral: ['api.mistral.ai'],
  deepseek: ['api.deepseek.com'],
  xai: ['api.x.ai'],
  togetherai: ['api.together.xyz'],
  'fireworks-ai': ['api.fireworks.ai'],
  fireworks: ['api.fireworks.ai'],
  cerebras: ['api.cerebras.ai'],
  opencode: ['opencode.ai'],
  zai: ['api.z.ai'],
  moonshotai: ['api.moonshot.ai'],
  'github-copilot': [
    'api.githubcopilot.com',
    'api.individual.githubcopilot.com',
    'api.business.githubcopilot.com',
    'api.enterprise.githubcopilot.com',
  ],
};

export const REGISTRY_HOSTS: readonly string[] = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
];

function hostOfUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    return url.port && url.port !== '443' ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return null;
  }
}

export interface AllowlistInput {
  /** Provider ids with stored credentials (keys of OpenCode's auth.json). */
  authProviders: readonly string[];
  /** `provider` section of the OpenCode config (custom providers/baseURLs). */
  configProviders: Readonly<Record<string, unknown>> | null;
  /** Comma-separated extra hosts (OPENLINEAR_SANDBOX_ALLOW_HOSTS). */
  extraHosts: string | undefined;
  includeRegistries: boolean;
}

/** Returns validated, de-duplicated host rules. Invalid extras are dropped. */
export function buildEgressAllowlist(input: AllowlistInput): { hosts: string[]; rejected: string[] } {
  const hosts = new Set<string>();
  const rejected: string[] = [];
  const providers = new Set([...input.authProviders, ...Object.keys(input.configProviders ?? {})]);
  for (const id of providers) for (const host of PROVIDER_HOSTS[id] ?? []) hosts.add(host);
  for (const value of Object.values(input.configProviders ?? {})) {
    if (!value || typeof value !== 'object') continue;
    const options = (value as { options?: { baseURL?: unknown } }).options;
    const host = hostOfUrl(options?.baseURL);
    if (host) hosts.add(host);
  }
  if (input.includeRegistries) for (const host of REGISTRY_HOSTS) hosts.add(host);
  for (const raw of (input.extraHosts ?? '').split(',')) {
    const value = raw.trim();
    if (!value) continue;
    try {
      parseHostRule(value);
      hosts.add(value.toLowerCase());
    } catch {
      rejected.push(value);
    }
  }
  return { hosts: [...hosts].sort(), rejected };
}
