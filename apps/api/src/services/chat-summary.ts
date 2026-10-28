/**
 * Summarizing compaction for Home Chat (optional, `CHAT_HISTORY_SUMMARY=1`).
 *
 * The prompt sends a stepped history window (chat-context.ts): once a session
 * is longer than the window, its oldest messages are no longer sent at all.
 * With compaction on, those messages are folded into a stored running
 * summary, sent as a second system message right after the static core and
 * the scope block:
 *
 *   tools → system (core, scope) → system (summary) → window → current turn
 *
 * The summary covers exactly the rows before the window start. The window
 * start only moves in steps of 16 messages, so the summary (and the cached
 * prefix through it) is reused byte-for-byte until the next step; then a new
 * summary is made incrementally (previous summary + the rows that just left
 * the window) and the prefix changes once, as it already did for the window.
 *
 * Every attempt is stored in `chat_session_summaries` (audit: covered range,
 * source hash, model, invocation id; failed attempts kept with their code)
 * and metered as `chat.summary` in `model_usage`. A failed attempt never
 * fails the turn: the previous summary (or none) is used.
 *
 * The summary is model-written from workspace text, so it is sent inside an
 * `<untrusted>` envelope and treated as context, not instructions.
 */
import { createHash } from 'node:crypto';
import { prisma, type ChatMessage } from '@openlinear/db';
import { logger } from '../logger';
import {
  ChatLLMError,
  type ChatLLMAttemptFailure,
  type ChatLLMClient,
  type ChatLLMEvent,
  type ChatLLMMessage,
} from '../lib/chat-llm';
import { CHAT_SUMMARY_PROMPT } from '../lib/chat-prompts';
import { compactToolContent, historyWindowStart, toolCallsToLLM } from './chat-context';

/** Off unless `CHAT_HISTORY_SUMMARY=1` (an extra model call per window step: owner decision). */
export function historySummaryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CHAT_HISTORY_SUMMARY?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

const SOURCE_MAX_ROWS = 400;
const SOURCE_MAX_CHARS = 48_000;
const ROW_MAX_CHARS = 2_000;
const TOOL_RESULT_MAX_CHARS = 1_000;
const SUMMARY_MAX_TOKENS = 600;
const SUMMARY_MAX_CHARS = 4_000;

/** The metering surface the summary call reports to (a TurnMeter in chat.ts). */
export interface MeteredCallRecorder {
  retried(key: string, round: number | null, failure: ChatLLMAttemptFailure): Promise<void>;
  failed(key: string, round: number | null, error: unknown, fallbackLatencyMs: number): Promise<void>;
  succeeded(key: string, round: number | null, done: Extract<ChatLLMEvent, { type: 'done' }>, fallbackLatencyMs: number): Promise<void>;
  invocationIdOf(key: string, attempt: number): string;
}

/**
 * One non-streaming model call with every attempt metered (titles,
 * summaries). Uses `completeChatCompletion` when the client has it, else the
 * stream. A stream without a terminal event is `LLM_STREAM_TRUNCATED`.
 */
export async function completeMetered(
  client: ChatLLMClient,
  meter: MeteredCallRecorder,
  key: string,
  input: { messages: ChatLLMMessage[]; maxTokens: number; model?: string; json?: boolean; abortSignal?: AbortSignal; streamMaxTokens?: number },
): Promise<{ content: string; attempt: number }> {
  const model = input.model ?? client.model;
  const startedAt = Date.now();
  if (client.completeChatCompletion) {
    try {
      const completion = await client.completeChatCompletion({
        messages: input.messages,
        maxTokens: input.maxTokens,
        temperature: 0,
        model,
        ...(input.json ? { json: true } : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      for (const failure of completion.failures) await meter.retried(key, null, failure);
      await meter.succeeded(key, null, {
        type: 'done',
        finishReason: completion.finishReason,
        usage: completion.usage,
        attempt: completion.attempt,
        latencyMs: completion.latencyMs,
        providerRequestId: completion.providerRequestId,
        model: completion.model,
      }, Date.now() - startedAt);
      return { content: completion.content, attempt: completion.attempt };
    } catch (error) {
      if (error instanceof ChatLLMError) {
        for (const failure of (error.info.failures ?? []).slice(0, -1)) await meter.retried(key, null, failure);
      }
      await meter.failed(key, null, error, Date.now() - startedAt);
      throw error;
    }
  }

  let content = '';
  let done: Extract<ChatLLMEvent, { type: 'done' }> | null = null;
  try {
    for await (const event of client.streamChatCompletion({
      messages: input.messages,
      maxTokens: input.streamMaxTokens ?? input.maxTokens,
      temperature: 0,
      model,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    })) {
      if (event.type === 'delta') content += event.content;
      else if (event.type === 'retry') await meter.retried(key, null, event.failure);
      else if (event.type === 'done') done = event;
    }
  } catch (error) {
    await meter.failed(key, null, error, Date.now() - startedAt);
    throw error;
  }
  if (!done) {
    const truncated = new ChatLLMError('LLM_STREAM_TRUNCATED', 'The stream ended before the response was complete', 502, { kind: 'stream' });
    await meter.failed(key, null, truncated, Date.now() - startedAt);
    throw truncated;
  }
  await meter.succeeded(key, null, done, Date.now() - startedAt);
  return { content, attempt: done.attempt ?? 1 };
}

export interface HistorySummary {
  id: string;
  /** The oldest `coveredMessages` rows of the session are summarised. */
  coveredMessages: number;
  content: string;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One transcript line per row, bounded; empty failure markers are skipped. */
export function renderRowForSummary(row: ChatMessage): string | null {
  if (row.role === 'user') return `User: ${clip(row.content ?? '', ROW_MAX_CHARS)}`;
  if (row.role === 'assistant') {
    const parts: string[] = [];
    if (row.content?.trim()) parts.push(`Assistant${row.incomplete ? ' (incomplete reply)' : ''}: ${clip(row.content, ROW_MAX_CHARS)}`);
    for (const call of toolCallsToLLM(row.toolCalls) ?? []) {
      parts.push(`Assistant called ${call.function.name}(${clip(call.function.arguments, 300)})`);
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (row.role === 'tool') return `Tool result (${row.toolName ?? 'tool'}): ${compactToolContent(row.content ?? '', TOOL_RESULT_MAX_CHARS)}`;
  return null;
}

function sourceHashOf(rows: ChatMessage[]): string {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(row.id).update('\u0000').update(row.content ?? '').update('\u0001');
  return hash.digest('hex');
}

function untrustedTranscript(body: string): string {
  const safe = body.replace(/<\/?untrusted/gi, '&lt;untrusted');
  return `<untrusted source="chat-history" kind="transcript">\n${safe}\n</untrusted>`;
}

/**
 * The summary that covers exactly the rows before the history window start of
 * a session with `total` messages: reused when stored, otherwise made now
 * (incrementally) and stored. Null when the window covers the whole session.
 */
export async function ensureHistorySummary(input: {
  sessionId: string;
  total: number;
  turnId: string;
  client: ChatLLMClient;
  meter: MeteredCallRecorder;
  abortSignal?: AbortSignal;
}): Promise<HistorySummary | null> {
  const target = historyWindowStart(input.total);
  if (target <= 0) return null;

  const previous = await prisma.chatSessionSummary.findFirst({
    where: { sessionId: input.sessionId, status: 'succeeded', coveredMessages: { lte: target } },
    orderBy: [{ coveredMessages: 'desc' }, { createdAt: 'desc' }],
  });
  if (previous?.content && previous.coveredMessages === target) {
    return { id: previous.id, coveredMessages: target, content: previous.content };
  }

  const from = previous?.coveredMessages ?? 0;
  // A very long gap (first summary of an old session) keeps its newest rows.
  const skip = Math.max(from, target - SOURCE_MAX_ROWS);
  const rows = await prisma.chatMessage.findMany({
    where: { sessionId: input.sessionId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    skip,
    take: target - skip,
  });
  const omitted = skip - from;
  let excerpt = rows.map(renderRowForSummary).filter((line): line is string => line !== null).join('\n');
  if (excerpt.length > SOURCE_MAX_CHARS) excerpt = `…${excerpt.slice(excerpt.length - SOURCE_MAX_CHARS)}`;
  const userContent = [
    previous?.content ? `Previous summary (messages 1–${from}):\n${previous.content}` : 'Previous summary: none.',
    '',
    `New conversation excerpt (messages ${skip + 1}–${target}${omitted > 0 ? `; ${omitted} older messages were omitted` : ''}):`,
    untrustedTranscript(excerpt),
  ].join('\n');
  const messages: ChatLLMMessage[] = [
    { role: 'system', content: CHAT_SUMMARY_PROMPT },
    { role: 'user', content: userContent },
  ];
  const key = `s${target}`;
  const audit = {
    sessionId: input.sessionId,
    coveredMessages: target,
    previousSummaryId: previous?.id ?? null,
    fromMessageId: rows[0]?.id ?? null,
    throughMessageId: rows.at(-1)?.id ?? null,
    throughCreatedAt: rows.at(-1)?.createdAt ?? null,
    sourceMessages: rows.length,
    sourceHash: sourceHashOf(rows),
    provider: (input.client.provider ?? 'unknown').slice(0, 64),
    model: input.client.model.slice(0, 200),
    turnId: input.turnId,
    inputChars: CHAT_SUMMARY_PROMPT.length + userContent.length,
  };

  try {
    const completion = await completeMetered(input.client, input.meter, key, {
      messages,
      maxTokens: SUMMARY_MAX_TOKENS,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    const content = completion.content.trim().slice(0, SUMMARY_MAX_CHARS);
    if (!content) throw new ChatLLMError('LLM_EMPTY_RESPONSE', 'The summary came back empty', 502, { kind: 'stream' });
    const row = await prisma.chatSessionSummary.create({
      data: { ...audit, status: 'succeeded', content, invocationId: input.meter.invocationIdOf(key, completion.attempt), outputChars: content.length },
      select: { id: true },
    });
    return { id: row.id, coveredMessages: target, content };
  } catch (error) {
    const code = error instanceof ChatLLMError ? error.code : 'CHAT_SUMMARY_FAILED';
    try {
      await prisma.chatSessionSummary.create({
        data: { ...audit, status: 'failed', content: null, errorCode: code.slice(0, 64), invocationId: null, outputChars: 0 },
      });
    } catch (err) {
      logger.warn({ err, sessionId: input.sessionId }, '[chat] could not record a failed summary attempt');
    }
    logger.warn({ err: error, sessionId: input.sessionId, coveredMessages: target }, '[chat] history summary failed; continuing without a fresh summary');
    return previous?.content ? { id: previous.id, coveredMessages: previous.coveredMessages, content: previous.content } : null;
  }
}
