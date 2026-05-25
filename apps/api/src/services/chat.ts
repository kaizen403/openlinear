import { prisma, type ChatMessage, type Prisma } from '@openlinear/db';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger';
import { broadcastToChatSession } from '../sse';
import { ChatLLMError, getChatLLMClient, type ChatLLMContentPart, type ChatLLMMessage, type ChatLLMToolCall } from '../lib/chat-llm';
import { buildChatSystemPrompt, CHAT_TITLE_PROMPT } from '../lib/chat-prompts';
import { assertProjectAccess } from './ownership';
import { assertWorkspaceRole } from './workspaces';
import { dispatchTool, getOpenAIFunctionSpecs } from './chat-tools';
import { isRecord, toJsonInput, type JsonObject, type ToolResult } from './chat-tools/types';

export type ChatChunk =
  | { type: 'user_message'; messageId: string; sessionId: string }
  | { type: 'assistant_delta'; content: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; args: JsonObject }
  | { type: 'tool_result'; toolCallId: string; toolName: string; result: ToolResult }
  | { type: 'assistant_final'; messageId: string; content: string }
  | { type: 'done'; sessionId: string }
  | { type: 'error'; code: string; message: string; details?: unknown };

export interface RunChatTurnInput {
  sessionId: string;
  userId: string;
  userMessage: string;
  attachmentIds?: string[];
  abortSignal?: AbortSignal;
}

interface AccumulatedToolCall {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

const MAX_TOOL_ROUNDS = 16;
const RECENT_MESSAGE_LIMIT = 32;

function parseToolArguments(raw: string): JsonObject {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toolCallsToLLM(value: Prisma.JsonValue | null): ChatLLMToolCall[] | undefined {
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

function compactTaskRecord(value: unknown): JsonObject | null {
  if (!isRecord(value)) return null;
  const compact: JsonObject = {};
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

function compactToolContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return raw.slice(0, 8000);
    const compact = {
      ok: parsed.ok,
      code: parsed.code,
      message: parsed.message,
      ...(parsed.data !== undefined ? { data: compactToolData(parsed.data) } : {}),
      ...(parsed.details !== undefined ? { details: parsed.details } : {}),
    };
    const serialized = JSON.stringify(compact);
    return serialized.length > 8000 ? `${serialized.slice(0, 8000)}…` : serialized;
  } catch {
    return raw.length > 8000 ? `${raw.slice(0, 8000)}…` : raw;
  }
}

function messageToLLM(message: ChatMessage): ChatLLMMessage | null {
  if (message.role === 'system') return null;
  if (message.role === 'tool') {
    if (!message.toolCallId) return null;
    return { role: 'tool', tool_call_id: message.toolCallId, content: compactToolContent(message.content ?? '') };
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: toolCallsToLLM(message.toolCalls),
    };
  }
  return { role: 'user', content: message.content ?? '' };
}

async function loadSessionForTurn(sessionId: string, userId: string) {
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId, archivedAt: null },
    select: { id: true, userId: true, workspaceId: true, projectId: true, title: true },
  });
  if (!session) return null;
  await assertWorkspaceRole(session.workspaceId, userId, ['owner', 'admin', 'member', 'viewer']);
  if (session.projectId) await assertProjectAccess(session.projectId, userId, 'view');
  return session;
}

async function buildMessages(session: Awaited<ReturnType<typeof loadSessionForTurn>>): Promise<ChatLLMMessage[]> {
  if (!session) return [];
  const rows = await prisma.chatMessage.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
    take: RECENT_MESSAGE_LIMIT,
  });
  const recent = rows.reverse().map(messageToLLM).filter((message): message is ChatLLMMessage => message !== null);
  return [
    { role: 'system', content: buildChatSystemPrompt({ userId: session.userId, workspaceId: session.workspaceId, projectId: session.projectId }) },
    ...recent,
  ];
}

function accumulatedToToolCalls(calls: AccumulatedToolCall[], round: number): ChatLLMToolCall[] {
  return calls
    .sort((a, b) => a.index - b.index)
    .filter((call) => Boolean(call.name))
    .map((call) => ({
      id: call.id ?? `tool_${round}_${call.index}`,
      type: 'function' as const,
      function: {
        name: call.name ?? 'unknown',
        arguments: call.arguments,
      },
    }));
}

async function maybeAutoTitle(input: {
  sessionId: string;
  userMessage: string;
  assistantMessage: string;
}) {
  const session = await prisma.chatSession.findUnique({
    where: { id: input.sessionId },
    select: { title: true },
  });
  if (!session || session.title !== 'New chat') return;

  const userMessageCount = await prisma.chatMessage.count({
    where: { sessionId: input.sessionId, role: 'user' },
  });
  if (userMessageCount !== 1) return;

  void (async () => {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const client = getChatLLMClient();
        const titleMessages: ChatLLMMessage[] = [
          { role: 'system', content: CHAT_TITLE_PROMPT },
          { role: 'user', content: `User message:\n${input.userMessage.slice(0, 2000)}\n\nAssistant answer:\n${input.assistantMessage.slice(0, 2000)}` },
        ];

        let rawTitle = '';
        if (client.completeChatCompletion) {
          rawTitle = await client.completeChatCompletion({
            messages: titleMessages,
            toolChoice: 'none',
            maxTokens: 80,
            json: true,
          });
        } else {
          for await (const event of client.streamChatCompletion({
            messages: titleMessages,
            toolChoice: 'none',
            maxTokens: 60,
          })) {
            if (event.type === 'delta') rawTitle += event.content;
          }
        }

        const parsed = parseTitleResponse(rawTitle);
        const cleaned = parsed.replace(/["""]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!cleaned) {
          if (attempt < maxAttempts) {
            await new Promise(r => setTimeout(r, 1000 * attempt));
            continue;
          }
          return;
        }
        const updated = await prisma.chatSession.update({
          where: { id: input.sessionId },
          data: { title: cleaned },
        });
        await broadcastToChatSession(input.sessionId, 'chat:session:updated', updated);
        return;
      } catch (err) {
        logger.warn({ err, sessionId: input.sessionId, attempt }, '[chat] auto-title failed');
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }
  })();
}

function parseTitleResponse(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed) && typeof parsed.title === 'string') {
      return parsed.title;
    }
  } catch {
    // Fall through to plain text cleanup for test doubles and older providers.
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return parseTitleResponse(fenced[1]);
  const titleMatch = trimmed.match(/"title"\s*:\s*"([^"]+)"/i);
  if (titleMatch?.[1]) return titleMatch[1];
  return trimmed.split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}

function providerErrorToChunk(error: unknown): ChatChunk {
  if (error instanceof ChatLLMError) {
    return { type: 'error', code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { type: 'error', code: 'CHAT_TURN_FAILED', message: error.message };
  }
  return { type: 'error', code: 'CHAT_TURN_FAILED', message: 'Chat turn failed' };
}

export async function* runChatTurn(input: RunChatTurnInput): AsyncIterable<ChatChunk> {
  const session = await loadSessionForTurn(input.sessionId, input.userId);
  if (!session) {
    yield { type: 'error', code: 'SESSION_NOT_FOUND', message: 'Chat session not found' };
    return;
  }

  const userRow = await prisma.chatMessage.create({
    data: {
      sessionId: session.id,
      userId: input.userId,
      role: 'user',
      content: input.userMessage,
    },
  });

  if (input.attachmentIds?.length) {
    await prisma.chatAttachment.updateMany({
      where: { id: { in: input.attachmentIds }, userId: input.userId, messageId: null },
      data: { messageId: userRow.id },
    });
  }

  yield { type: 'user_message', messageId: userRow.id, sessionId: session.id };

  const client = getChatLLMClient();
  const tools = getOpenAIFunctionSpecs();
  let messages = await buildMessages(session);

  if (input.attachmentIds?.length) {
    const attachments = await prisma.chatAttachment.findMany({
      where: { id: { in: input.attachmentIds }, userId: input.userId },
    });
    const contentParts: ChatLLMContentPart[] = [{ type: 'text', text: input.userMessage }];
    for (const att of attachments) {
      const filePath = path.resolve(process.cwd(), att.url.replace(/^\//, ''));
      if (att.mimeType.startsWith('image/')) {
        try {
          const data = await fs.readFile(filePath);
          const b64 = data.toString('base64');
          contentParts.push({ type: 'image_url', image_url: { url: `data:${att.mimeType};base64,${b64}`, detail: 'auto' } });
        } catch { /* skip unreadable */ }
      } else if (att.mimeType === 'application/pdf') {
        try {
          const { PDFParse } = await import('pdf-parse');
          const data = await fs.readFile(filePath);
          const parser = new PDFParse({ data });
          const result = await parser.getText();
          contentParts.push({ type: 'text', text: `[PDF: ${att.filename}]\n${result.text.slice(0, 10000)}` });
        } catch { /* skip unreadable */ }
      } else {
        try {
          const text = await fs.readFile(filePath, 'utf-8');
          contentParts.push({ type: 'text', text: `[File: ${att.filename}]\n${text.slice(0, 50000)}` });
        } catch { /* skip unreadable */ }
      }
    }
    if (contentParts.length > 1) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        messages[messages.length - 1] = { ...lastMsg, content: contentParts };
      }
    }
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    if (input.abortSignal?.aborted) {
      yield { type: 'error', code: 'CLIENT_ABORTED', message: 'Chat request was aborted' };
      return;
    }

    let assistantContent = '';
    const toolCallMap = new Map<number, AccumulatedToolCall>();

    try {
      for await (const event of client.streamChatCompletion({
        messages,
        tools,
        toolChoice: 'auto',
        abortSignal: input.abortSignal,
      })) {
        if (event.type === 'delta') {
          assistantContent += event.content;
          yield { type: 'assistant_delta', content: event.content };
        } else if (event.type === 'tool_call_delta') {
          const existing = toolCallMap.get(event.index) ?? { index: event.index, arguments: '' };
          toolCallMap.set(event.index, {
            ...existing,
            id: event.id ?? existing.id,
            name: event.name ?? existing.name,
            arguments: existing.arguments + (event.argumentsDelta ?? ''),
          });
        }
      }
    } catch (error) {
      if (assistantContent.trim()) {
        await prisma.chatMessage.create({
          data: { sessionId: session.id, role: 'assistant', content: assistantContent },
        });
      }
      yield providerErrorToChunk(error);
      return;
    }

    const toolCalls = accumulatedToToolCalls(Array.from(toolCallMap.values()), round);
    if (toolCalls.length === 0) {
      const assistant = await prisma.chatMessage.create({
        data: {
          sessionId: session.id,
          role: 'assistant',
          content: assistantContent,
        },
      });
      yield { type: 'assistant_final', messageId: assistant.id, content: assistantContent };
      yield { type: 'done', sessionId: session.id };
      await maybeAutoTitle({ sessionId: session.id, userMessage: input.userMessage, assistantMessage: assistantContent });
      return;
    }

    const assistantWithTools = await prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        role: 'assistant',
        content: assistantContent || null,
        toolCalls: toJsonInput(toolCalls),
      },
    });

    messages = [
      ...messages,
      { role: 'assistant', content: assistantContent || null, tool_calls: toolCalls },
    ];

    for (const call of toolCalls) {
      const args = parseToolArguments(call.function.arguments);
      yield { type: 'tool_call_start', toolCallId: call.id, toolName: call.function.name, args };
      const result = await dispatchTool(call.function.name, {
        userId: input.userId,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        projectId: session.projectId,
        toolCallId: call.id,
        messageId: assistantWithTools.id,
        abortSignal: input.abortSignal,
      }, args);
      yield { type: 'tool_result', toolCallId: call.id, toolName: call.function.name, result };
      const toolMessage = await prisma.chatMessage.create({
        data: {
          sessionId: session.id,
          role: 'tool',
          content: JSON.stringify(result),
          toolCallId: call.id,
          toolName: call.function.name,
        },
      });
      messages = [
        ...messages,
        { role: 'tool', tool_call_id: call.id, content: toolMessage.content ?? JSON.stringify(result) },
      ];
    }
  }

  yield { type: 'error', code: 'ROUND_LIMIT', message: 'The chat turn exceeded the safe tool-call round limit' };
}
