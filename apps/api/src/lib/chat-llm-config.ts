/**
 * Home Chat model provider configuration, validated from the environment.
 *
 * DATA PROCESSOR NOTICE
 * ---------------------
 * The deployment default is Fireworks AI (`https://api.fireworks.ai/inference/v1`)
 * serving `accounts/fireworks/models/kimi-k2p6`. Changing the default is an owner
 * decision (see docs/reports/revamp-2026-10-26/ai.md); operators choose another
 * processor with the variables below. Each Home Chat model request sends:
 *  - the static system rules and the tool catalogue (no tenant data);
 *  - a scope block with the user id, workspace id, project id and UTC date;
 *  - the session's recent history window: user messages, assistant replies,
 *    tool calls with their arguments and tool results. Tool results contain
 *    workspace data the user can read: issue titles, descriptions, statuses,
 *    comments, labels, project/team names, and member usernames, email
 *    addresses and avatar URLs (member and team listings);
 *  - attachments sent with the current message: images as base64 data URLs,
 *    extracted PDF/text content.
 * Title generation sends the first user message and the first answer (each
 * truncated to 2,000 characters). Retention and training use at the processor
 * follow that provider's terms; nothing here configures them.
 *
 * Variables (all optional; invalid values disable chat with LLM_MISCONFIGURED
 * rather than silently falling back):
 *  - CHAT_LLM_BASE_URL       OpenAI-compatible base URL. https required, except
 *                            loopback hosts or CHAT_LLM_ALLOW_INSECURE_HTTP=1.
 *  - CHAT_LLM_API_KEY        Provider key (legacy fallback: FIREWORKS_API_KEY).
 *  - CHAT_LLM_MODEL          Model id for chat turns.
 *  - CHAT_LLM_TITLE_MODEL    Model id for session titles (default: CHAT_LLM_MODEL).
 *  - CHAT_LLM_PROVIDER       Provider label; inferred from the host when unset.
 *  - CHAT_LLM_TIMEOUT_MS     Wait for response headers and between stream chunks.
 *  - CHAT_LLM_MAX_ATTEMPTS   Attempts per model call for 429/5xx/network (1-6).
 *  - CHAT_LLM_RETRY_BASE_DELAY_MS / CHAT_LLM_RETRY_MAX_DELAY_MS  Backoff bounds.
 *  - CHAT_LLM_CACHE_HINTS    auto | none | anthropic (cache_control breakpoints).
 *  - CHAT_LLM_STREAM_USAGE   1/0: request `stream_options.include_usage`.
 *  - CHAT_LLM_MAX_OUTPUT_TOKENS  Per-call `max_tokens` (unset: provider default).
 *  - CHAT_TURN_TIMEOUT_MS    Upper bound for one chat turn, all rounds included.
 *  - CHAT_MAX_TOOL_ROUNDS    Model calls per turn (1-32).
 *  - MODEL_PRICING_JSON      Price snapshot for cost estimates (see llm-usage.ts).
 */
import { z } from 'zod';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './llm-retry';
import { pricingTableSchema, type PricingTable } from './llm-usage';

export const DEFAULT_CHAT_LLM_BASE_URL = 'https://api.fireworks.ai/inference/v1';
export const DEFAULT_CHAT_LLM_MODEL = 'accounts/fireworks/models/kimi-k2p6';

export const CHAT_LLM_PROVIDERS = [
  'fireworks',
  'openai',
  'azure_openai',
  'openrouter',
  'anthropic',
  'moonshot',
  'deepseek',
  'together',
  'groq',
  'openai_compatible',
] as const;
export type ChatLLMProvider = (typeof CHAT_LLM_PROVIDERS)[number];

export const CACHE_HINT_MODES = ['auto', 'none', 'anthropic'] as const;
export type CacheHintMode = (typeof CACHE_HINT_MODES)[number];

export interface ChatLLMConfig {
  provider: ChatLLMProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  titleModel: string;
  requestTimeoutMs: number;
  retry: RetryPolicy;
  cacheHints: CacheHintMode;
  streamUsage: boolean;
  maxOutputTokens: number | null;
  turnTimeoutMs: number;
  maxToolRounds: number;
  pricing: PricingTable | null;
}

export type ChatLLMConfigResult = { ok: true; config: ChatLLMConfig } | { ok: false; issues: string[] };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const HOST_PROVIDERS: Array<[RegExp, ChatLLMProvider]> = [
  [/(^|\.)fireworks\.ai$/, 'fireworks'],
  [/(^|\.)openai\.azure\.com$/, 'azure_openai'],
  [/^api\.openai\.com$/, 'openai'],
  [/(^|\.)openrouter\.ai$/, 'openrouter'],
  [/^api\.anthropic\.com$/, 'anthropic'],
  [/(^|\.)moonshot\.(ai|cn)$/, 'moonshot'],
  [/(^|\.)deepseek\.com$/, 'deepseek'],
  [/(^|\.)together\.(xyz|ai)$/, 'together'],
  [/(^|\.)groq\.com$/, 'groq'],
];

export function inferProvider(baseUrl: string): ChatLLMProvider {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    for (const [pattern, provider] of HOST_PROVIDERS) {
      if (pattern.test(host)) return provider;
    }
  } catch {
    // Validation reports malformed URLs; inference just falls through.
  }
  return 'openai_compatible';
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

const intString = (min: number, max: number) =>
  z.string().trim().regex(/^\d+$/, 'must be a whole number').transform(Number).pipe(z.number().int().min(min).max(max));

const booleanString = z.string().trim().toLowerCase().pipe(z.enum(['1', '0', 'true', 'false']))
  .transform((value) => value === '1' || value === 'true');

const modelIdString = z.string().trim().min(1).max(200).regex(/^\S+$/, 'must not contain whitespace');

const envSchema = z.object({
  CHAT_LLM_BASE_URL: z.string().trim().url().optional(),
  CHAT_LLM_ALLOW_INSECURE_HTTP: booleanString.optional(),
  CHAT_LLM_PROVIDER: z.enum(CHAT_LLM_PROVIDERS).optional(),
  CHAT_LLM_MODEL: modelIdString.optional(),
  CHAT_LLM_TITLE_MODEL: modelIdString.optional(),
  CHAT_LLM_TIMEOUT_MS: intString(1_000, 600_000).optional(),
  CHAT_LLM_MAX_ATTEMPTS: intString(1, 6).optional(),
  CHAT_LLM_RETRY_BASE_DELAY_MS: intString(0, 10_000).optional(),
  CHAT_LLM_RETRY_MAX_DELAY_MS: intString(0, 60_000).optional(),
  CHAT_LLM_CACHE_HINTS: z.enum(CACHE_HINT_MODES).optional(),
  CHAT_LLM_STREAM_USAGE: booleanString.optional(),
  CHAT_LLM_MAX_OUTPUT_TOKENS: intString(1, 1_000_000).optional(),
  CHAT_TURN_TIMEOUT_MS: intString(1_000, 1_800_000).optional(),
  CHAT_MAX_TOOL_ROUNDS: intString(1, 32).optional(),
  MODEL_PRICING_JSON: z.string().optional(),
});

/** Read only the variables this module owns, treating blank values as unset. */
function pickEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) {
    picked[key] = nonEmpty(env[key]);
  }
  return picked;
}

export function loadChatLLMConfig(env: NodeJS.ProcessEnv = process.env): ChatLLMConfigResult {
  const parsed = envSchema.safeParse(pickEnv(env));
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    };
  }
  const values = parsed.data;
  const issues: string[] = [];

  const baseUrl = (values.CHAT_LLM_BASE_URL ?? DEFAULT_CHAT_LLM_BASE_URL).replace(/\/+$/, '');
  const url = new URL(baseUrl);
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || values.CHAT_LLM_ALLOW_INSECURE_HTTP))) {
    issues.push('CHAT_LLM_BASE_URL: must use https (http is allowed only for loopback hosts or with CHAT_LLM_ALLOW_INSECURE_HTTP=1)');
  }
  if (url.username || url.password) {
    issues.push('CHAT_LLM_BASE_URL: must not embed credentials; use CHAT_LLM_API_KEY');
  }

  const retry: RetryPolicy = {
    maxAttempts: values.CHAT_LLM_MAX_ATTEMPTS ?? DEFAULT_RETRY_POLICY.maxAttempts,
    baseDelayMs: values.CHAT_LLM_RETRY_BASE_DELAY_MS ?? DEFAULT_RETRY_POLICY.baseDelayMs,
    maxDelayMs: values.CHAT_LLM_RETRY_MAX_DELAY_MS ?? DEFAULT_RETRY_POLICY.maxDelayMs,
  };
  if (retry.maxDelayMs < retry.baseDelayMs) {
    issues.push('CHAT_LLM_RETRY_MAX_DELAY_MS: must be at least CHAT_LLM_RETRY_BASE_DELAY_MS');
  }

  let pricing: PricingTable | null = null;
  if (values.MODEL_PRICING_JSON) {
    let raw: unknown;
    try {
      raw = JSON.parse(values.MODEL_PRICING_JSON);
    } catch {
      issues.push('MODEL_PRICING_JSON: must be valid JSON');
    }
    if (raw !== undefined) {
      const table = pricingTableSchema.safeParse(raw);
      if (table.success) {
        pricing = table.data;
      } else {
        issues.push(...table.error.issues.map((issue) => `MODEL_PRICING_JSON.${issue.path.join('.')}: ${issue.message}`));
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const model = values.CHAT_LLM_MODEL ?? DEFAULT_CHAT_LLM_MODEL;
  return {
    ok: true,
    config: {
      provider: values.CHAT_LLM_PROVIDER ?? inferProvider(baseUrl),
      baseUrl,
      apiKey: nonEmpty(env.CHAT_LLM_API_KEY) ?? nonEmpty(env.FIREWORKS_API_KEY) ?? '',
      model,
      titleModel: values.CHAT_LLM_TITLE_MODEL ?? model,
      requestTimeoutMs: values.CHAT_LLM_TIMEOUT_MS ?? 60_000,
      retry,
      cacheHints: values.CHAT_LLM_CACHE_HINTS ?? 'auto',
      streamUsage: values.CHAT_LLM_STREAM_USAGE ?? true,
      maxOutputTokens: values.CHAT_LLM_MAX_OUTPUT_TOKENS ?? null,
      turnTimeoutMs: values.CHAT_TURN_TIMEOUT_MS ?? 300_000,
      maxToolRounds: values.CHAT_MAX_TOOL_ROUNDS ?? 16,
      pricing,
    },
  };
}

/**
 * Whether to send Anthropic-style `cache_control` breakpoints. `auto` sends
 * them only where the endpoint is documented to forward them (OpenRouter in
 * front of Anthropic models); OpenAI, Fireworks, DeepSeek and Moonshot cache a
 * repeated prefix automatically and need no hints.
 */
export function shouldSendCacheHints(config: Pick<ChatLLMConfig, 'cacheHints' | 'provider'>, model: string): boolean {
  if (config.cacheHints === 'anthropic') return true;
  if (config.cacheHints === 'none') return false;
  return config.provider === 'openrouter' && model.startsWith('anthropic/');
}

/** Providers whose `usage.cost` is a documented USD amount. */
export function providerReportsCost(provider: string): boolean {
  return provider === 'openrouter';
}

export interface ChatDataProcessorDescription {
  provider: ChatLLMProvider;
  host: string;
  model: string;
  titleModel: string;
  isDefault: boolean;
}

export function describeChatDataProcessor(config: ChatLLMConfig): ChatDataProcessorDescription {
  return {
    provider: config.provider,
    host: new URL(config.baseUrl).host,
    model: config.model,
    titleModel: config.titleModel,
    isDefault: config.baseUrl === DEFAULT_CHAT_LLM_BASE_URL && config.model === DEFAULT_CHAT_LLM_MODEL,
  };
}
