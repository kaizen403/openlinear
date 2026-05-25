export type ChatLLMRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatLLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatLLMContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export interface ChatLLMMessage {
  role: ChatLLMRole;
  content?: string | ChatLLMContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ChatLLMToolCall[];
}

export interface ChatLLMFunctionSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export type ChatLLMEvent =
  | { type: 'delta'; content: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'done'; finishReason?: string; inputTokens?: number; outputTokens?: number };

export interface StreamChatCompletionInput {
  messages: ChatLLMMessage[];
  tools?: ChatLLMFunctionSpec[];
  toolChoice?: 'auto' | 'none';
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

export interface ChatLLMClient {
  readonly model: string;
  streamChatCompletion(input: StreamChatCompletionInput): AsyncIterable<ChatLLMEvent>;
  completeChatCompletion?(input: StreamChatCompletionInput & { json?: boolean }): Promise<string>;
}

export class ChatLLMError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 502,
  ) {
    super(message);
    this.name = 'ChatLLMError';
  }
}

function getEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function buildAbortSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  if (parent) {
    if (parent.aborted) controller.abort();
    parent.addEventListener('abort', () => controller.abort(), { once: true });
  }

  controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
  return { signal: controller.signal, didTimeout: () => timedOut };
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted'));
}

function toRequestError(error: unknown, timeout: { didTimeout: () => boolean }, parent?: AbortSignal): ChatLLMError {
  if (error instanceof ChatLLMError) return error;
  if (parent?.aborted) return new ChatLLMError('CLIENT_ABORTED', 'Chat request was aborted by the client', 499);
  if (timeout.didTimeout()) return new ChatLLMError('LLM_TIMEOUT', 'The model request timed out before it returned a response', 504);
  if (isAbortLikeError(error)) return new ChatLLMError('LLM_REQUEST_ABORTED', 'The model request was aborted before it returned a response', 502);
  return new ChatLLMError('LLM_REQUEST_FAILED', error instanceof Error ? error.message : 'Model request failed');
}

export class OpenAICompatibleChatLLM implements ChatLLMClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (firstNonEmpty(options.baseUrl, process.env.CHAT_LLM_BASE_URL) ?? 'https://api.fireworks.ai/inference/v1').replace(/\/$/, '');
    this.apiKey = firstNonEmpty(options.apiKey, process.env.CHAT_LLM_API_KEY, process.env.FIREWORKS_API_KEY) ?? '';
    this.model = firstNonEmpty(options.model, process.env.CHAT_LLM_MODEL) ?? 'accounts/fireworks/models/kimi-k2p6';
    this.timeoutMs = options.timeoutMs ?? getEnvNumber('CHAT_LLM_TIMEOUT_MS', 60000);
  }

  async completeChatCompletion(input: StreamChatCompletionInput & { json?: boolean }): Promise<string> {
    if (!this.apiKey) {
      throw new ChatLLMError('LLM_NOT_CONFIGURED', 'Chat LLM API key is not configured', 500);
    }

    const timeout = buildAbortSignal(this.timeoutMs, input.abortSignal);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: input.messages,
          tools: input.tools,
          tool_choice: input.toolChoice ?? (input.tools?.length ? 'auto' : 'none'),
          temperature: 0,
          max_tokens: input.maxTokens,
          ...(input.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: timeout.signal,
      });
    } catch (error) {
      throw toRequestError(error, timeout, input.abortSignal);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const safeMessage = text.slice(0, 300).replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
      throw new ChatLLMError('LLM_REQUEST_FAILED', safeMessage || `Provider returned HTTP ${response.status}`, response.status);
    }

    const payload = asRecord(await response.json().catch((error: unknown) => {
      throw toRequestError(error, timeout, input.abortSignal);
    }));
    const choice = asRecord(asArray(payload?.choices)[0]);
    const message = asRecord(choice?.message);
    return stringValue(message?.content) ?? '';
  }

  async *streamChatCompletion(input: StreamChatCompletionInput): AsyncIterable<ChatLLMEvent> {
    if (!this.apiKey) {
      throw new ChatLLMError('LLM_NOT_CONFIGURED', 'Chat LLM API key is not configured', 500);
    }

    const timeout = buildAbortSignal(this.timeoutMs, input.abortSignal);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: input.messages,
          tools: input.tools,
          tool_choice: input.toolChoice ?? (input.tools?.length ? 'auto' : 'none'),
          temperature: 0.1,
          max_tokens: input.maxTokens,
          stream: true,
        }),
        signal: timeout.signal,
      });
    } catch (error) {
      throw toRequestError(error, timeout, input.abortSignal);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const safeMessage = text.slice(0, 300).replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
      throw new ChatLLMError('LLM_REQUEST_FAILED', safeMessage || `Provider returned HTTP ${response.status}`, response.status);
    }
    if (!response.body) {
      throw new ChatLLMError('LLM_EMPTY_STREAM', 'Provider returned an empty stream');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const dataLines = frame
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());
          for (const data of dataLines) {
            if (!data || data === '[DONE]') continue;
            const parsed = asRecord(JSON.parse(data));
            if (!parsed) continue;
            const choice = asRecord(asArray(parsed.choices)[0]);
            if (!choice) continue;
            const finishReason = stringValue(choice.finish_reason);
            const delta = asRecord(choice.delta);
            if (delta) {
              const content = stringValue(delta.content);
              if (content) yield { type: 'delta', content };
              for (const rawToolCall of asArray(delta.tool_calls)) {
                const toolCall = asRecord(rawToolCall);
                if (!toolCall) continue;
                const fn = asRecord(toolCall.function);
                yield {
                  type: 'tool_call_delta',
                  index: numberValue(toolCall.index) ?? 0,
                  id: stringValue(toolCall.id),
                  name: fn ? stringValue(fn.name) : undefined,
                  argumentsDelta: fn ? stringValue(fn.arguments) : undefined,
                };
              }
            }
            if (finishReason) {
              const usage = asRecord(parsed.usage);
              yield {
                type: 'done',
                finishReason,
                inputTokens: usage ? numberValue(usage.prompt_tokens) : undefined,
                outputTokens: usage ? numberValue(usage.completion_tokens) : undefined,
              };
            }
          }
        }
      }
    } catch (error) {
      throw toRequestError(error, timeout, input.abortSignal);
    }
  }
}

let testClient: ChatLLMClient | null = null;

export function setChatLLMClientForTesting(client: ChatLLMClient | null): void {
  testClient = client;
}

export function getChatLLMClient(): ChatLLMClient {
  return testClient ?? new OpenAICompatibleChatLLM();
}
