import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';
import { setChatLLMClientForTesting, type ChatLLMClient, type ChatLLMEvent, type StreamChatCompletionInput } from '../lib/chat-llm';

const JWT_SECRET = 'openlinear-dev-secret-change-in-production';

class ScriptedClient implements ChatLLMClient {
  readonly model = 'test-chat-model';
  private index = 0;

  constructor(private readonly scripts: ChatLLMEvent[][]) {}

  async *streamChatCompletion(_input: StreamChatCompletionInput): AsyncIterable<ChatLLMEvent> {
    const events = this.scripts[this.index] ?? [];
    this.index += 1;
    for (const event of events) yield event;
  }
}

function token(userId: string, username: string) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

async function cleanup() {
  await prisma.chatToolCall.deleteMany({});
  await prisma.chatMessage.deleteMany({});
  await prisma.chatSession.deleteMany({});
  await prisma.taskLabel.deleteMany({});
  await prisma.task.deleteMany({});
  await prisma.label.deleteMany({});
  await prisma.teamMember.deleteMany({});
  await prisma.team.deleteMany({});
  await prisma.projectAccess.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.workspaceMember.deleteMany({});
  await prisma.workspace.deleteMany({});
}

describe('Chat streaming endpoint', () => {
  const app = createApp();
  let userId: string;
  let username: string;
  let workspaceId: string;
  let sessionId: string;
  let auth: string;

  beforeAll(async () => {
    await cleanup();
    const user = await prisma.user.upsert({
      where: { githubId: 'chat-stream-user' },
      update: { username: 'chatstreamuser', email: 'chatstream@example.com' },
      create: { githubId: 'chat-stream-user', username: 'chatstreamuser', email: 'chatstream@example.com' },
    });
    userId = user.id;
    username = user.username;
    auth = token(userId, username);
    const workspace = await prisma.workspace.create({ data: { name: 'Stream Workspace', slug: 'stream-workspace' } });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner', joinedAt: new Date() } });
    const session = await prisma.chatSession.create({ data: { userId, workspaceId } });
    sessionId = session.id;
  }, 30000);

  afterEach(() => {
    setChatLLMClientForTesting(null);
  });

  afterAll(async () => {
    setChatLLMClientForTesting(null);
    await cleanup();
  }, 30000);

  it('streams tool calls, tool results, final text, and done marker over SSE', async () => {
    setChatLLMClientForTesting(new ScriptedClient([
      [
        { type: 'tool_call_delta', index: 0, id: 'call_list_workspaces', name: 'list_workspaces', argumentsDelta: '{}' },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'delta', content: 'I found your workspace from live data.' },
        { type: 'done', finishReason: 'stop' },
      ],
      [],
    ]));

    const res = await request(app)
      .post(`/api/chat/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ content: 'List my workspaces' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('event: tool_call_start');
    expect(res.text).toContain('event: tool_result');
    expect(res.text).toContain('event: assistant_final');
    expect(res.text).toContain('event: done');
    expect(res.text).toContain('Stream Workspace');

    const toolCall = await prisma.chatToolCall.findUnique({
      where: { sessionId_toolCallId: { sessionId, toolCallId: 'call_list_workspaces' } },
    });
    expect(toolCall?.status).toBe('succeeded');
  });
});
