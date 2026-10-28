/**
 * W18a tool safety: effect classification, the server-issued confirmation
 * gate for destructive tools, per-turn journal identity, abort-before-start
 * and reconciliation of interrupted writes.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useTestServer } from './http';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import {
  setChatLLMClientForTesting,
  type ChatLLMClient,
  type ChatLLMEvent,
  type StreamChatCompletionInput,
} from '../lib/chat-llm';
import { runChatTurn, type ChatChunk } from '../services/chat';
import { CHAT_TOOLS, dispatchTool, getOpenAIFunctionSpecs, getToolSpecsHash } from '../services/chat-tools';
import { collectUserConfirmations, extractConfirmationCodes } from '../services/chat-tools/confirmations';
import type { JsonObject, ToolContext, ToolResult } from '../services/chat-tools/types';
import { runWithPrincipal } from '../tenancy/context';
import { testJwtSecret } from './test-env';

type Script = (input: StreamChatCompletionInput, call: number) => ChatLLMEvent[];

/** A model double whose next reply can depend on the request it receives. */
class DynamicClient implements ChatLLMClient {
  readonly model = 'test-chat-model';
  readonly provider = 'test';
  private call = 0;

  constructor(private readonly script: Script) {}

  async *streamChatCompletion(input: StreamChatCompletionInput): AsyncIterable<ChatLLMEvent> {
    const events = this.script(input, this.call);
    this.call += 1;
    for (const event of events) yield event;
  }
}

const suffix = randomUUID().slice(0, 8);

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

function codeOf(result: ToolResult): string {
  const details = result.details as { confirmation?: { code?: unknown } } | undefined;
  const code = details?.confirmation?.code;
  if (typeof code !== 'string') throw new Error(`expected a confirmation code, got ${JSON.stringify(result)}`);
  return code;
}

function lastToolMessageCode(input: StreamChatCompletionInput): string | null {
  for (const message of [...input.messages].reverse()) {
    if (message.role === 'tool' && typeof message.content === 'string') {
      const [code] = extractConfirmationCodes(message.content);
      if (code) return code;
    }
  }
  return null;
}

function toolCall(id: string, name: string, args: JsonObject): ChatLLMEvent[] {
  return [
    { type: 'tool_call_delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
    { type: 'done', finishReason: 'tool_calls' },
  ];
}

function say(text: string): ChatLLMEvent[] {
  return [{ type: 'delta', content: text }, { type: 'done', finishReason: 'stop' }];
}

describe('Chat tool safety (W18a)', () => {
  let userId = '';
  let username = '';
  let workspaceId = '';
  let projectId = '';
  let teamId = '';

  async function newSession(): Promise<string> {
    const session = await prisma.chatSession.create({ data: { userId, workspaceId, projectId, title: 'Safety session' } });
    return session.id;
  }

  function ctx(sessionId: string, extra: Partial<ToolContext> = {}): ToolContext {
    return { userId, workspaceId, sessionId, projectId, toolCallId: `call-${randomUUID()}`, ...extra };
  }

  async function seedIssues(count: number, status: 'todo' | 'in_progress' = 'todo'): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const number = Math.floor(Math.random() * 1_000_000_000);
      const task = await prisma.task.create({
        data: { title: `Safety issue ${i}`, identifier: `SAF-${number}`, number, status, projectId, teamId, workspaceId },
      });
      ids.push(task.id);
    }
    return ids;
  }

  async function statuses(ids: string[]): Promise<string[]> {
    const rows = await prisma.task.findMany({ where: { id: { in: ids } }, select: { status: true } });
    return rows.map((row) => row.status);
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { githubId: `chat-safety-${suffix}`, username: `chatsafety${suffix}`, email: `chatsafety-${suffix}@example.com` },
    });
    userId = user.id;
    username = user.username;
    const workspace = await prisma.workspace.create({ data: { name: `Safety ${suffix}`, slug: `safety-${suffix}` } });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner', joinedAt: new Date() } });
    const project = await prisma.project.create({ data: { workspaceId, name: `Safety project ${suffix}`, key: 'SAF' } });
    projectId = project.id;
    const team = await prisma.team.create({ data: { name: 'Safety team', key: `SF${suffix.slice(0, 3)}`, projectId } });
    teamId = team.id;
    await prisma.teamMember.create({ data: { teamId, userId, role: 'owner' } });
    await prisma.projectAccess.create({ data: { projectId, userId, permission: 'full' } });
  }, 30000);

  afterEach(async () => {
    setChatLLMClientForTesting(null);
    delete process.env.OPENLINEAR_ENABLE_CHAT_PRIVILEGE_TOOLS;
    // Each test starts from a clean board.
    await prisma.task.deleteMany({ where: { projectId } });
  });

  afterAll(async () => {
    await prisma.chatSession.deleteMany({ where: { userId } });
    await prisma.task.deleteMany({ where: { projectId } });
    await prisma.teamMember.deleteMany({ where: { teamId } });
    await prisma.team.deleteMany({ where: { id: teamId } });
    await prisma.projectAccess.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }, 30000);

  describe('effect classification', () => {
    it('gives every tool an effect and gates exactly the destructive ones', () => {
      const tools = Object.values(CHAT_TOOLS);
      expect(tools).toHaveLength(40);
      const byEffect = (effect: string) => tools.filter((tool) => tool.effect === effect).map((tool) => tool.name).sort();
      expect(byEffect('read')).toHaveLength(17);
      expect(byEffect('destructive')).toEqual([
        'archive_issues',
        'bulk_update_issues',
        'change_team_member_role',
        'change_workspace_member_role',
        'grant_project_access',
        'invite_team_member',
        'invite_workspace_member',
      ]);
      expect(byEffect('external')).toEqual([]);
      expect(byEffect('write')).toHaveLength(16);
      for (const tool of tools) expect(tool).not.toHaveProperty('mutating');
    });

    it('offers confirmationToken only on destructive tools, in a frozen, hash-stable catalogue', () => {
      const specs = getOpenAIFunctionSpecs();
      for (const spec of specs) {
        const properties = (spec.function.parameters as { properties?: Record<string, unknown> }).properties ?? {};
        const destructive = CHAT_TOOLS[spec.function.name as keyof typeof CHAT_TOOLS].effect === 'destructive';
        expect('confirmationToken' in properties, spec.function.name).toBe(destructive);
      }
      expect(getOpenAIFunctionSpecs()).toBe(specs);
      expect(getToolSpecsHash()).toMatch(/^[0-9a-f]{64}$/);
      expect(getToolSpecsHash()).toBe(getToolSpecsHash());
    });
  });

  describe('bulk_update_issues confirmation', () => {
    it('previews the whole project, then applies only after the user sends the code in a later turn', async () => {
      const sessionId = await newSession();
      const ids = await seedIssues(3);
      setChatLLMClientForTesting(new DynamicClient((input, call) => {
        if (call === 0) return toolCall('call_bulk', 'bulk_update_issues', { status: 'done' });
        if (call === 1) return say('This will mark 3 issues done. Reply with the code to proceed.');
        if (call === 2) {
          const code = lastToolMessageCode(input);
          return toolCall('call_bulk', 'bulk_update_issues', { status: 'done', confirmationToken: code ?? 'missing' });
        }
        return say('Done.');
      }));

      const first = await collect(runChatTurn({ sessionId, userId, userMessage: 'Mark everything done' }));
      const confirmation = first.find((chunk) => chunk.type === 'confirmation_required');
      expect(confirmation && confirmation.type === 'confirmation_required' ? confirmation.code : '').toMatch(/^CONFIRM-[0-9A-Z]{8}$/);
      expect(await statuses(ids)).toEqual(['todo', 'todo', 'todo']);
      const code = confirmation && confirmation.type === 'confirmation_required' ? confirmation.code : '';

      const second = await collect(runChatTurn({ sessionId, userId, userMessage: `yes, ${code.toLowerCase()}` }));
      const result = second.find((chunk) => chunk.type === 'tool_result');
      expect(result && result.type === 'tool_result' ? result.result.ok : false).toBe(true);
      expect(await statuses(ids)).toEqual(['done', 'done', 'done']);

      const row = await prisma.chatToolConfirmation.findFirstOrThrow({ where: { sessionId } });
      expect(row.consumedAt).not.toBeNull();
      expect(row.issuedTurnId).not.toBe(row.consumedTurnId);
      expect(row.codeHash).not.toContain(code);
    });

    it('refuses a code the model sends without the user having confirmed it', async () => {
      const sessionId = await newSession();
      const ids = await seedIssues(2);
      setChatLLMClientForTesting(new DynamicClient((input, call) => {
        if (call === 0) return toolCall('call_bulk', 'bulk_update_issues', { status: 'cancelled' });
        if (call === 1) return say('Please confirm.');
        if (call === 2) return toolCall('call_bulk', 'bulk_update_issues', { status: 'cancelled', confirmationToken: lastToolMessageCode(input) ?? '' });
        return say('Could not.');
      }));

      await collect(runChatTurn({ sessionId, userId, userMessage: 'Cancel all issues' }));
      // "yes" is not the code: model narration or a bare affirmative is not consent.
      const second = await collect(runChatTurn({ sessionId, userId, userMessage: 'yes' }));
      const result = second.find((chunk) => chunk.type === 'tool_result');
      expect(result && result.type === 'tool_result' ? result.result.code : '').toBe('CONFIRMATION_NOT_FROM_USER');
      expect(await statuses(ids)).toEqual(['todo', 'todo']);
    });

    it('rejects redemption in the issuing turn, a changed change, a concurrent edit, reuse and expiry', async () => {
      const sessionId = await newSession();
      const ids = await seedIssues(2);
      const preview = await dispatchTool('bulk_update_issues', ctx(sessionId, { turnId: 'turn-1' }), { status: 'done' });
      expect(preview.code).toBe('CONFIRMATION_REQUIRED');
      const code = codeOf(preview);
      const userSent = collectUserConfirmations(`ok ${code}`);

      const sameTurn = await dispatchTool('bulk_update_issues', ctx(sessionId, { turnId: 'turn-1', userConfirmations: userSent }), { status: 'done', confirmationToken: code });
      expect(sameTurn.code).toBe('CONFIRMATION_REQUIRES_USER_TURN');

      const otherStatus = await dispatchTool('bulk_update_issues', ctx(sessionId, { turnId: 'turn-2', userConfirmations: userSent }), { status: 'cancelled', confirmationToken: code });
      expect(otherStatus.code).toBe('CONFIRMATION_STALE');

      await prisma.task.update({ where: { id: ids[0] }, data: { title: 'Edited after the preview' } });
      const edited = await dispatchTool('bulk_update_issues', ctx(sessionId, { turnId: 'turn-2', userConfirmations: userSent }), { status: 'done', confirmationToken: code });
      expect(edited.code).toBe('CONFIRMATION_STALE');
      expect(await statuses(ids)).toEqual(['todo', 'todo']);

      const fresh = codeOf(await dispatchTool('bulk_update_issues', ctx(sessionId, { turnId: 'turn-2' }), { status: 'done' }));
      const freshSent = collectUserConfirmations(fresh);
      const applied = await dispatchTool('bulk_update_issues', ctx(sessionId, { turnId: 'turn-3', userConfirmations: freshSent }), { status: 'done', confirmationToken: fresh });
      expect(applied.ok).toBe(true);
      expect(await statuses(ids)).toEqual(['done', 'done']);

      const reused = await dispatchTool('bulk_update_issues', ctx(sessionId, { turnId: 'turn-4', userConfirmations: freshSent }), { status: 'done', confirmationToken: fresh });
      // Nothing left to change is reported before the code is examined.
      expect(reused.ok).toBe(true);
      expect(reused.data).toMatchObject({ updated: [] });

      await prisma.task.updateMany({ where: { id: { in: ids } }, data: { status: 'todo' } });
      const expiring = codeOf(await dispatchTool('bulk_update_issues', ctx(sessionId, { turnId: 'turn-5' }), { status: 'done' }));
      await prisma.chatToolConfirmation.updateMany({
        where: { sessionId, consumedAt: null },
        data: { createdAt: new Date(Date.now() - 20 * 60_000), expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await dispatchTool('bulk_update_issues', ctx(sessionId, { turnId: 'turn-6', userConfirmations: collectUserConfirmations(expiring) }), { status: 'done', confirmationToken: expiring });
      expect(expired.code).toBe('CONFIRMATION_EXPIRED');
      expect(await statuses(ids)).toEqual(['todo', 'todo']);
    });

    it('consumes a code once even under concurrent redemption', async () => {
      const sessionId = await newSession();
      const ids = await seedIssues(2);
      const code = codeOf(await dispatchTool('bulk_update_issues', ctx(sessionId, { turnId: 't1' }), { status: 'in_progress' }));
      const sent = collectUserConfirmations(code);
      const results = await Promise.all([1, 2, 3].map((n) =>
        dispatchTool('bulk_update_issues', ctx(sessionId, { turnId: `t2-${n}`, userConfirmations: sent }), { status: 'in_progress', confirmationToken: code })));
      const executed = results.filter((result) => result.ok && (result.details as { confirmationId?: string } | undefined)?.confirmationId);
      expect(executed).toHaveLength(1);
      // A loser either lost the claim, or previewed after the winner and found nothing left to change.
      for (const result of results.filter((candidate) => !executed.includes(candidate))) {
        if (result.ok) expect(result.data).toMatchObject({ updated: [] });
        else expect(result.code).toBe('CONFIRMATION_USED');
      }
      expect(await statuses(ids)).toEqual(['in_progress', 'in_progress']);
      await expect(prisma.chatToolConfirmation.count({ where: { sessionId, consumedAt: { not: null } } })).resolves.toBe(1);
    });

    it('does not accept a code issued in another session', async () => {
      const sessionA = await newSession();
      const sessionB = await newSession();
      await seedIssues(1);
      const code = codeOf(await dispatchTool('bulk_update_issues', ctx(sessionA, { turnId: 'a1' }), { status: 'done' }));
      const crossed = await dispatchTool('bulk_update_issues', ctx(sessionB, { turnId: 'b1', userConfirmations: collectUserConfirmations(code) }), { status: 'done', confirmationToken: code });
      expect(crossed.code).toBe('CONFIRMATION_INVALID');
    });

    it('binds explicit issueIds exactly and leaves every other issue alone', async () => {
      const sessionId = await newSession();
      const [first, second, untouched] = await seedIssues(3);
      const unknown = randomUUID();
      const preview = await dispatchTool('bulk_update_issues', ctx(sessionId, { turnId: 'x1' }), { status: 'done', issueIds: [first, second, unknown] });
      expect(preview.code).toBe('CONFIRMATION_REQUIRED');
      const details = preview.details as { preview: { willChange: Array<{ id: string }>; notFound: string[]; selection: string } };
      expect(details.preview.selection).toBe('explicit_issue_ids');
      expect(details.preview.willChange.map((issue) => issue.id).sort()).toEqual([first, second].sort());
      expect(details.preview.notFound).toEqual([unknown]);

      const code = codeOf(preview);
      const applied = await dispatchTool('bulk_update_issues', ctx(sessionId, { turnId: 'x2', userConfirmations: collectUserConfirmations(code) }), { status: 'done', issueIds: [first, second, unknown], confirmationToken: code });
      expect(applied.ok).toBe(true);
      expect(applied.data).toMatchObject({ failed: [{ id: unknown }] });
      expect(await statuses([first, second])).toEqual(['done', 'done']);
      expect(await statuses([untouched])).toEqual(['todo']);
    });

    it('refuses to select more than 100 active issues implicitly', async () => {
      const sessionId = await newSession();
      await prisma.task.createMany({
        data: Array.from({ length: 101 }, (_, i) => ({ title: `Bulk ${i}`, identifier: `BIG-${suffix}-${i}`, number: 2_000_000 + i, projectId, teamId, workspaceId })),
      });
      const result = await dispatchTool('bulk_update_issues', ctx(sessionId), { status: 'done' });
      expect(result.code).toBe('SELECTION_TOO_LARGE');
      await expect(prisma.chatToolConfirmation.count({ where: { sessionId } })).resolves.toBe(0);
    });
  });

  describe('archive_issues confirmation', () => {
    const http = useTestServer(() => createApp());

    it('accepts the structured confirmationTokens field on the message route', async () => {
      const auth = jwt.sign({ userId, username }, testJwtSecret(), { expiresIn: '1h' });
      const sessionId = await newSession();
      const [target, keep] = await seedIssues(2);
      const targetRow = await prisma.task.findUniqueOrThrow({ where: { id: target } });
      setChatLLMClientForTesting(new DynamicClient((input, call) => {
        if (call === 0) return toolCall('call_archive', 'archive_issues', { issueIdentifiers: [targetRow.identifier ?? ''] });
        if (call === 1) return say('Confirm with the button.');
        if (call === 2) return toolCall('call_archive', 'archive_issues', { issueIdentifiers: [targetRow.identifier ?? ''], confirmationToken: lastToolMessageCode(input) ?? '' });
        return say('Archived.');
      }));

      const first = await http().post(`/api/chat/sessions/${sessionId}/messages`).set('Authorization', `Bearer ${auth}`).send({ content: 'Archive that issue' });
      expect(first.status).toBe(200);
      expect(first.text).toContain('event: confirmation_required');
      const code = extractConfirmationCodes(first.text)[0] ?? '';
      expect(await prisma.task.count({ where: { id: target, archived: true } })).toBe(0);

      const malformed = await http().post(`/api/chat/sessions/${sessionId}/messages`).set('Authorization', `Bearer ${auth}`).send({ content: 'Confirm', confirmationTokens: ['not-a-code'] });
      expect(malformed.status).toBe(400);

      const second = await http().post(`/api/chat/sessions/${sessionId}/messages`).set('Authorization', `Bearer ${auth}`).send({ content: 'Confirmed', confirmationTokens: [code] });
      expect(second.status).toBe(200);
      expect(await prisma.task.count({ where: { id: target, archived: true } })).toBe(1);
      expect(await prisma.task.count({ where: { id: keep, archived: false } })).toBe(1);
    });
  });

  describe('privilege tools', () => {
    it('still require confirmation when an operator re-enables them', async () => {
      process.env.OPENLINEAR_ENABLE_CHAT_PRIVILEGE_TOOLS = '1';
      const sessionId = await newSession();
      const before = await prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId, userId } });
      const result = await dispatchTool('change_workspace_member_role', ctx(sessionId), { userId, role: 'viewer' });
      expect(result.code).toBe('CONFIRMATION_REQUIRED');
      const after = await prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId, userId } });
      expect(after.role).toBe(before.role);
    });
  });

  describe('dispatch safety', () => {
    it('never starts a handler for an already-aborted call', async () => {
      const sessionId = await newSession();
      const controller = new AbortController();
      controller.abort();
      const title = `Aborted ${suffix}`;
      const result = await dispatchTool('create_issue', ctx(sessionId, { abortSignal: controller.signal, journalKey: `abort-${suffix}` }), { title });
      expect(result.code).toBe('CLIENT_ABORTED');
      await expect(prisma.task.count({ where: { projectId, title } })).resolves.toBe(0);
      const row = await prisma.chatToolCall.findFirstOrThrow({ where: { sessionId, toolCallId: `abort-${suffix}` } });
      expect(row.status).toBe('cancelled');
    });

    it('reports an interrupted write as outcome-unknown and records its real outcome later', async () => {
      const sessionId = await newSession();
      const title = `Interrupted ${suffix}`;
      const journalKey = `interrupted-${suffix}`;
      const controller = new AbortController();
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const lockHeld = new Promise<void>((resolve) => {
        locked = resolve;
      });
      // Hold the team row so issue numbering (and therefore the write) blocks.
      const lock = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM teams WHERE id = ${teamId} FOR UPDATE`;
        locked();
        await released;
      }, { timeout: 20_000 });
      await lockHeld;

      const pending = dispatchTool('create_issue', ctx(sessionId, { abortSignal: controller.signal, journalKey }), { title });
      for (let i = 0; i < 100; i += 1) {
        const row = await prisma.chatToolCall.findFirst({ where: { sessionId, toolCallId: journalKey } });
        if (row?.status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      controller.abort();
      const result = await pending;
      expect(result.code).toBe('TOOL_OUTCOME_UNKNOWN');
      await expect(prisma.task.count({ where: { projectId, title } })).resolves.toBe(0);

      release();
      await lock;
      let reconciled = null;
      for (let i = 0; i < 100; i += 1) {
        reconciled = await prisma.chatToolCall.findFirst({ where: { sessionId, toolCallId: journalKey } });
        if (reconciled?.status === 'succeeded') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(reconciled?.status).toBe('succeeded');
      expect(JSON.stringify(reconciled?.output)).toContain('"reconciledAfter":"CLIENT_ABORTED"');
      await expect(prisma.task.count({ where: { projectId, title } })).resolves.toBe(1);
    });

    it('refuses unparseable tool arguments instead of running the tool with {}', async () => {
      const sessionId = await newSession();
      await seedIssues(2);
      setChatLLMClientForTesting(new DynamicClient((_input, call) => {
        if (call === 0) {
          return [
            { type: 'tool_call_delta', index: 0, id: 'call_broken', name: 'bulk_update_issues', argumentsDelta: '{"status": "done", "issueIds": [' },
            { type: 'done', finishReason: 'tool_calls' },
          ];
        }
        return say('Sorry.');
      }));
      const chunks = await collect(runChatTurn({ sessionId, userId, userMessage: 'Close them' }));
      const result = chunks.find((chunk) => chunk.type === 'tool_result');
      expect(result && result.type === 'tool_result' ? result.result.code : '').toBe('INVALID_TOOL_ARGUMENTS');
      const row = await prisma.chatToolCall.findFirstOrThrow({ where: { sessionId, providerToolCallId: 'call_broken' } });
      expect(row.status).toBe('failed');
      await expect(prisma.chatToolConfirmation.count({ where: { sessionId } })).resolves.toBe(0);
    });

    it('applies PAT scopes by effect: a read-only token cannot preview a destructive tool', async () => {
      const sessionId = await newSession();
      await seedIssues(1);
      const result = await runWithPrincipal({
        userId,
        authSource: 'pat',
        scopes: ['read'],
        credentialId: 'pat-test',
        workspaceRestriction: null,
        workspaces: new Map([[workspaceId, 'owner']]),
        teams: new Set([teamId]),
        projectGrants: new Map([[projectId, 'full']]),
        resolvedAt: Date.now(),
      }, () => dispatchTool('bulk_update_issues', ctx(sessionId), { status: 'done' }));
      expect(result.code).toBe('INSUFFICIENT_SCOPE');
    });
  });
});
