/**
 * Prompt assembly for Home Chat turns.
 *
 * Layout (stable first, volatile last, so providers can reuse a cached prefix):
 *   tools (frozen catalogue)
 *   → system: static core rules, then the per-session scope block
 *   → history window (chunked, so its start only moves every 16 messages)
 *   → current user message → this turn's tool rounds.
 */
import { createHash } from 'node:crypto';
import { prisma, type ChatMessage, type Prisma } from '@openlinear/db';
import type { ChatLLMContentPart, ChatLLMFunctionSpec, ChatLLMMessage, ChatLLMToolCall } from '../lib/chat-llm';
import { CHAT_SYSTEM_PROMPT_CORE } from '../lib/chat-prompts';
import { isRecord } from './chat-tools/types';

/** The window always holds at least this many messages (when the session has them). */
export const HISTORY_WINDOW_MIN = 32;
/** The window start advances in steps of this size, keeping the prefix stable between steps. */
export const HISTORY_WINDOW_STEP = 16;

const TOOL_RESULT_MAX_CHARS = 8000;
const OVERFLOW_KEEP_HISTORY = 8;
const OVERFLOW_HISTORY_TOOL_MAX_CHARS = 1500;
const OVERFLOW_CURRENT_TOOL_MAX_CHARS = 4000;

/**
 * First message position of the history window for a session of `total`
 * messages. A sliding "newest N" window changes its first message on every
 * turn once a session is longer than N, so no cached history prefix survives.
 * Stepping the start keeps it fixed for up to 16 messages (several turns).
 */
export function historyWindowStart(total: number): number {
  if (total <= HISTORY_WINDOW_MIN) return 0;
  return Math.floor((total - HISTORY_WINDOW_MIN) / HISTORY_WINDOW_STEP) * HISTORY_WINDOW_STEP;
}

function compactTaskRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const compact: Record<string, unknown> = {};
  for (const key of ['id', 'identifier', 'title', 'status', 'priority', 'teamId', 'projectId', 'assigneeId', 'parentId', 'dueDate']) {
    const item = value[key];
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null) {
      compact[key] = item;
    }
  }
  return Object.keys(compact).length > 0 ? compact : null;
}

function compactArray(value: unknown, limit = 100): unknown[] | null {
  if (!Array.isArray(value)) return null;
  return value.slice(0, limit).map((item) => compactTaskRecord(item) ?? item);
}

function compactToolData(data: unknown): unknown {
  if (Array.isArray(data)) return compactArray(data);
  if (!isRecord(data)) return data;

  if (Array.isArray(data.data)) {
    return {
      data: compactArray(data.data),
      ...(data.nextCursor !== undefined ? { nextCursor: data.nextCursor } : {}),
    };
  }
  if (Array.isArray(data.tasks)) {
    return {
      ...Object.fromEntries(
        ['id', 'key', 'name', 'status', 'workspaceId', 'targetDate']
          .map((key) => [key, data[key]])
          .filter(([, value]) => value !== undefined),
      ),
      tasks: compactArray(data.tasks),
      ...('_count' in data ? { _count: data._count } : {}),
    };
  }
  if (Array.isArray(data.preview)) {
    return { ...data, preview: compactArray(data.preview) };
  }
  if (Array.isArray(data.created)) {
    return { ...data, created: compactArray(data.created) };
  }
  if (Array.isArray(data.updated)) {
    return {
      ...data,
      updated: compactArray(data.updated),
      already: compactArray(data.already),
    };
  }
  if (Array.isArray(data.archived)) {
    return { ...data, archived: compactArray(data.archived) };
  }
  return data;
}

/** Same compaction in-flight and on replay, so both produce identical bytes. */
export function compactToolContent(raw: string, maxChars = TOOL_RESULT_MAX_CHARS): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return raw.slice(0, maxChars);
    const compact = {
      ok: parsed.ok,
      code: parsed.code,
      message: parsed.message,
      ...(parsed.data !== undefined ? { data: compactToolData(parsed.data) } : {}),
      ...(parsed.details !== undefined ? { details: parsed.details } : {}),
    };
    const serialized = JSON.stringify(compact);
    return serialized.length > maxChars ? `${serialized.slice(0, maxChars)}…` : serialized;
  } catch {
    return raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
  }
}

export function toolCallsToLLM(value: Prisma.JsonValue | null): ChatLLMToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: ChatLLMToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item.function) ? item.function : null;
    if (typeof item.id !== 'string' || !fn || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') continue;
    calls.push({ id: item.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } });
  }
  return calls;
}

export function messageToLLM(message: ChatMessage): ChatLLMMessage | null {
  if (message.role === 'system') return null;
  if (message.role === 'tool') {
    if (!message.toolCallId) return null;
    return { role: 'tool', tool_call_id: message.toolCallId, content: compactToolContent(message.content ?? '') };
  }
  if (message.role === 'assistant') {
    const toolCalls = toolCallsToLLM(message.toolCalls);
    // A failed turn's empty marker row (incomplete, no text, no calls) carries
    // nothing for the model; providers reject empty assistant messages.
    if (!message.content?.trim() && !(toolCalls && toolCalls.length > 0)) return null;
    return {
      role: 'assistant',
      content: message.content ?? null,
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }
  return { role: 'user', content: message.content ?? '' };
}

/**
 * Keep only structurally valid assistant/tool groups.
 *
 * Providers reject a `tool` message whose id was not announced by the
 * immediately preceding assistant `tool_calls`, and an announced call without
 * its result. A window cut, a crash between rows or a reordered timestamp can
 * produce either. Drop orphan results, drop unanswered calls, and drop an
 * assistant message left with neither text nor calls.
 */
export function repairToolGroups(messages: ChatLLMMessage[]): ChatLLMMessage[] {
  const repaired: ChatLLMMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (!message) break;
    if (message.role === 'tool') {
      index += 1;
      continue;
    }
    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      repaired.push(message);
      index += 1;
      continue;
    }
    const results: ChatLLMMessage[] = [];
    let next = index + 1;
    while (next < messages.length && messages[next]?.role === 'tool') {
      const result = messages[next];
      if (result) results.push(result);
      next += 1;
    }
    const answered = new Set(results.map((result) => result.tool_call_id));
    const calls = message.tool_calls.filter((call) => answered.has(call.id));
    const callIds = new Set(calls.map((call) => call.id));
    const seen = new Set<string>();
    const keptResults = results.filter((result) => {
      const id = result.tool_call_id;
      if (!id || !callIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const hasText = typeof message.content === 'string' ? message.content.trim().length > 0 : Array.isArray(message.content) && message.content.length > 0;
    if (calls.length > 0) {
      repaired.push({ ...message, tool_calls: calls }, ...keptResults);
    } else if (hasText) {
      const { tool_calls: _dropped, ...withoutCalls } = message;
      repaired.push(withoutCalls);
    }
    index = next;
  }
  return repaired;
}

/** Load the chunked history window (oldest first). */
export async function loadHistoryWindow(sessionId: string): Promise<ChatMessage[]> {
  const total = await prisma.chatMessage.count({ where: { sessionId } });
  const take = total - historyWindowStart(total);
  if (take <= 0) return [];
  const rows = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  });
  return rows.reverse();
}

export function historyToLLM(rows: ChatMessage[]): ChatLLMMessage[] {
  return repairToolGroups(rows.map(messageToLLM).filter((message): message is ChatLLMMessage => message !== null));
}

function shrinkContent(message: ChatLLMMessage, toolMaxChars: number, dropImages: boolean): ChatLLMMessage {
  if (message.role === 'tool' && typeof message.content === 'string') {
    return { ...message, content: compactToolContent(message.content, toolMaxChars) };
  }
  if (dropImages && Array.isArray(message.content)) {
    const parts: ChatLLMContentPart[] = message.content.map((part) =>
      part.type === 'image_url' ? { type: 'text', text: '[image omitted to fit the context window]' } : part);
    return { ...message, content: parts };
  }
  return message;
}

/**
 * Deterministic compaction used once when the provider reports a context
 * overflow: keep the system message, the newest few history messages (in
 * valid groups) and the whole current turn, and tighten tool-result caps.
 */
export function trimMessagesForOverflow(messages: ChatLLMMessage[]): { messages: ChatLLMMessage[]; droppedMessages: number } {
  let systemCount = 0;
  while (systemCount < messages.length && messages[systemCount]?.role === 'system') systemCount += 1;
  let lastUser = messages.length - 1;
  while (lastUser >= systemCount && messages[lastUser]?.role !== 'user') lastUser -= 1;
  if (lastUser < systemCount) lastUser = messages.length;

  const system = messages.slice(0, systemCount);
  const history = messages.slice(systemCount, lastUser);
  const current = messages.slice(lastUser);
  const keptHistory = repairToolGroups(history.slice(-OVERFLOW_KEEP_HISTORY))
    .map((message) => shrinkContent(message, OVERFLOW_HISTORY_TOOL_MAX_CHARS, true));
  const currentTrimmed = current.map((message) => shrinkContent(message, OVERFLOW_CURRENT_TOOL_MAX_CHARS, false));
  return {
    messages: [...system, ...keptHistory, ...currentTrimmed],
    droppedMessages: history.length - keptHistory.length,
  };
}

/** Strictly increasing timestamps for rows written within one turn. */
export class MonotonicClock {
  private last = 0;

  next(): Date {
    const now = Date.now();
    this.last = now > this.last ? now : this.last + 1;
    return new Date(this.last);
  }
}

/** Hash of the cacheable prefix (tool catalogue + static rules). */
export function stablePrefixHash(tools: ChatLLMFunctionSpec[]): string {
  return createHash('sha256').update(JSON.stringify(tools)).update('\u0000').update(CHAT_SYSTEM_PROMPT_CORE).digest('hex');
}
