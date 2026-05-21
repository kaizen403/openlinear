import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { prisma } from '@openlinear/db';
import { setChatLLMClientForTesting, type ChatLLMClient, type ChatLLMEvent, type StreamChatCompletionInput } from '../lib/chat-llm';
import { runChatTurn } from '../services/chat';

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

describe('Chat orchestrator', () => {
  let userId: string;
  let workspaceId: string;
  let sessionId: string;

  beforeAll(async () => {
    await cleanup();
    const user = await prisma.user.upsert({
      where: { githubId: 'chat-orchestrator-user' },
      update: { username: 'chatorchestrator', email: 'chatorchestrator@example.com' },
      create: { githubId: 'chat-orchestrator-user', username: 'chatorchestrator', email: 'chatorchestrator@example.com' },
    });
    userId = user.id;
    const workspace = await prisma.workspace.create({ data: { name: 'Orchestrator Workspace', slug: 'orchestrator-workspace' } });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner', joinedAt: new Date() } });
    await prisma.project.create({ data: { workspaceId, name: 'Orchestrated Project', key: 'ORCH' } });
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

  it('streams a tool call, persists tool result, and only then finalizes an answer', async () => {
    setChatLLMClientForTesting(new ScriptedClient([
      [
        { type: 'tool_call_delta', index: 0, id: 'call_list_projects', name: 'list_projects', argumentsDelta: JSON.stringify({ workspaceId }) },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'delta', content: 'You have 1 project.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]));

    const chunks = [];
    for await (const chunk of runChatTurn({ sessionId, userId, userMessage: 'How many projects do I have?' })) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'user_message',
      'tool_call_start',
      'tool_result',
      'assistant_delta',
      'assistant_final',
      'done',
    ]);
    const toolRows = await prisma.chatToolCall.findMany({ where: { sessionId } });
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0].toolName).toBe('list_projects');
    expect(toolRows[0].status).toBe('succeeded');

    const messages = await prisma.chatMessage.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });
});
