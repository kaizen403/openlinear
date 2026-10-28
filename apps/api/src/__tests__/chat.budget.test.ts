/**
 * W15 chat budgets: per-workspace and per-member monthly caps (operator
 * config + admin overrides), reservation before a turn and reconciliation
 * with actual usage, stop codes, explicit unknown-cost policy, status on
 * GET /api/usage/models. Fake model clients only.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { Prisma, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { loadChatBudgetConfig } from '../lib/chat-budget-config';
import {
  setChatLLMClientForTesting,
  type ChatLLMClient,
  type ChatLLMEvent,
  type ChatLLMUsage,
  type StreamChatCompletionInput,
} from '../lib/chat-llm';
import { runChatTurn, type ChatChunk } from '../services/chat';
import { admitChatTurn, resolveEffectiveBudget } from '../services/chat-budget';
import { activeTurnLease } from '../services/chat-turn-lease';
import { useTestServer } from './http';
import { testJwtSecret } from './test-env';

const suffix = randomUUID().slice(0, 8);
const BUDGET_ENV = [
  'CHAT_BUDGET_WORKSPACE_MONTHLY_USD',
  'CHAT_BUDGET_WORKSPACE_MONTHLY_TOKENS',
  'CHAT_BUDGET_USER_MONTHLY_USD',
  'CHAT_BUDGET_USER_MONTHLY_TOKENS',
  'CHAT_BUDGET_UNKNOWN_COST',
  'CHAT_BUDGET_TURN_RESERVE_USD',
  'CHAT_BUDGET_TURN_RESERVE_TOKENS',
  'CHAT_BUDGET_WARN_AT',
  'MODEL_PRICING_JSON',
  'CHAT_LLM_MODEL',
];

/** $0.001 per token: a 100-in/20-out call costs $0.12. */
function usePricing(): void {
  process.env.CHAT_LLM_MODEL = 'test-chat-model';
  process.env.MODEL_PRICING_JSON = JSON.stringify({
    revision: 'test-2026-10',
    models: { 'test-chat-model': { inputPerMTok: 1000, outputPerMTok: 1000 } },
  });
}

function usage(input = 100, output = 20): ChatLLMUsage {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, providerCostUsd: null, raw: { prompt_tokens: input, completion_tokens: output } };
}

type Script = (call: number, input: StreamChatCompletionInput) => ChatLLMEvent[];

class ScriptedClient implements ChatLLMClient {
  readonly model = 'test-chat-model';
  readonly provider = 'test';
  calls = 0;

  constructor(private readonly script: Script) {}

  async *streamChatCompletion(input: StreamChatCompletionInput): AsyncIterable<ChatLLMEvent> {
    const events = this.script(this.calls, input);
    this.calls += 1;
    for (const event of events) yield event;
  }
}

const answer = (text = 'Here you go.'): ChatLLMEvent[] => [
  { type: 'delta', content: text },
  { type: 'done', finishReason: 'stop', usage: usage() },
];

const toolRound = (call: number): ChatLLMEvent[] => [
  { type: 'tool_call_delta', index: 0, id: `call_ws_${call}`, name: 'list_workspaces', argumentsDelta: '{}' },
  { type: 'done', finishReason: 'tool_calls', usage: usage() },
];

async function collect(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe('Chat budgets (W15)', () => {
  const http = useTestServer(() => createApp());
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  let owner = { id: '', auth: '' };
  let member = { id: '', auth: '' };

  async function makeUser(label: string) {
    const user = await prisma.user.create({
      data: { githubId: `chat-budget-${label}-${suffix}`, username: `chatbudget${label}${suffix}`, email: `chatbudget-${label}-${suffix}@example.com` },
    });
    userIds.push(user.id);
    return { id: user.id, auth: jwt.sign({ userId: user.id, username: user.username }, testJwtSecret(), { expiresIn: '1h' }) };
  }

  /** A fresh workspace (spend is measured per workspace and month). */
  async function newWorkspace(): Promise<{ workspaceId: string; ownerSession: string; memberSession: string }> {
    const workspace = await prisma.workspace.create({ data: { name: `Budget ${suffix}`, slug: `budget-${randomUUID().slice(0, 12)}` } });
    workspaceIds.push(workspace.id);
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: owner.id, role: 'owner', joinedAt: new Date() },
        { workspaceId: workspace.id, userId: member.id, role: 'member', joinedAt: new Date() },
      ],
    });
    const ownerSession = await prisma.chatSession.create({ data: { userId: owner.id, workspaceId: workspace.id } });
    const memberSession = await prisma.chatSession.create({ data: { userId: member.id, workspaceId: workspace.id } });
    return { workspaceId: workspace.id, ownerSession: ownerSession.id, memberSession: memberSession.id };
  }

  async function seedSpend(workspaceId: string, userId: string, costUsd: number | null, tokens = 120): Promise<void> {
    await prisma.modelUsage.create({
      data: {
        invocationId: `seed-${randomUUID()}`,
        surface: 'chat.turn',
        provider: 'test',
        model: 'test-chat-model',
        userId,
        workspaceId,
        status: 'succeeded',
        usageReported: true,
        inputTokens: tokens,
        outputTokens: 0,
        costUsd: costUsd === null ? null : new Prisma.Decimal(costUsd.toFixed(6)),
        costBasis: costUsd === null ? 'unknown' : 'estimated',
      },
    });
  }

  beforeAll(async () => {
    owner = await makeUser('owner');
    member = await makeUser('member');
  });

  afterEach(() => {
    setChatLLMClientForTesting(null);
    for (const key of BUDGET_ENV) delete process.env[key];
  });

  afterAll(async () => {
    await prisma.modelUsage.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.chatBudgetReservation.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.auditLog.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.chatSession.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  describe('configuration', () => {
    it('parses operator defaults and fails closed on invalid values', () => {
      const ok = loadChatBudgetConfig({ CHAT_BUDGET_WORKSPACE_MONTHLY_USD: '25.5', CHAT_BUDGET_USER_MONTHLY_TOKENS: '100000', CHAT_BUDGET_UNKNOWN_COST: 'BLOCK' });
      expect(ok).toEqual({
        ok: true,
        config: expect.objectContaining({ workspaceMonthlyUsd: 25.5, userMonthlyTokens: 100000, workspaceMonthlyTokens: null, userMonthlyUsd: null, unknownCostPolicy: 'block', turnReserveUsd: 0.05, turnReserveTokens: 50000, warnAt: 0.8 }),
      });
      expect(loadChatBudgetConfig({}).ok && loadChatBudgetConfig({}).ok).toBe(true);
      for (const bad of [{ CHAT_BUDGET_WORKSPACE_MONTHLY_USD: '-1' }, { CHAT_BUDGET_USER_MONTHLY_TOKENS: '1.5' }, { CHAT_BUDGET_UNKNOWN_COST: 'maybe' }, { CHAT_BUDGET_WARN_AT: '2' }]) {
        expect(loadChatBudgetConfig(bad).ok).toBe(false);
      }
    });

    it('refuses turns with 503 CHAT_BUDGET_MISCONFIGURED when the operator config is invalid', async () => {
      const { memberSession } = await newWorkspace();
      process.env.CHAT_BUDGET_WORKSPACE_MONTHLY_USD = 'lots';
      const res = await http().post(`/api/chat/sessions/${memberSession}/messages`).set('Authorization', `Bearer ${member.auth}`).send({ content: 'hi' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('CHAT_BUDGET_MISCONFIGURED');
      expect(await activeTurnLease(memberSession)).toBeNull();
    });
  });

  describe('admission and reconciliation', () => {
    it('does no budget work when no cap applies', async () => {
      const { workspaceId, ownerSession } = await newWorkspace();
      setChatLLMClientForTesting(new ScriptedClient(() => answer()));
      const chunks = await collect(runChatTurn({ sessionId: ownerSession, userId: owner.id, userMessage: 'hello' }));
      expect(chunks.at(-1)?.type).toBe('done');
      await expect(prisma.chatBudgetReservation.count({ where: { workspaceId } })).resolves.toBe(0);
    });

    it('refuses a turn with 402 CHAT_BUDGET_EXCEEDED before storing anything once the workspace cap is spent', async () => {
      usePricing();
      process.env.CHAT_BUDGET_WORKSPACE_MONTHLY_USD = '1';
      const { workspaceId, memberSession } = await newWorkspace();
      await seedSpend(workspaceId, owner.id, 1.0);
      const client = new ScriptedClient(() => answer());
      setChatLLMClientForTesting(client);
      const send = () => http().post(`/api/chat/sessions/${memberSession}/messages`).set('Authorization', `Bearer ${member.auth}`).send({ content: 'over budget?' });
      const res = await send();
      expect(res.status).toBe(402);
      expect(res.body.code).toBe('CHAT_BUDGET_EXCEEDED');
      expect(res.body.details).toMatchObject({ scope: 'workspace', dimension: 'usd', source: 'config' });
      // Workspace-wide spend is admin data: not in a member's refusal.
      expect(res.body.details.spent).toBeUndefined();
      expect(res.body.details.resetsAt).toMatch(/^\d{4}-\d{2}-01T00:00:00.000Z$/);
      expect(client.calls).toBe(0);
      await expect(prisma.chatMessage.count({ where: { sessionId: memberSession } })).resolves.toBe(0);
      // The lease was released: the next attempt is refused for budget again, not 409.
      expect((await send()).body.code).toBe('CHAT_BUDGET_EXCEEDED');
    });

    it('reserves before the turn and settles the reservation with the actual usage', async () => {
      usePricing();
      process.env.CHAT_BUDGET_WORKSPACE_MONTHLY_USD = '10';
      const { workspaceId, ownerSession } = await newWorkspace();
      setChatLLMClientForTesting(new ScriptedClient(() => answer()));
      const chunks = await collect(runChatTurn({ sessionId: ownerSession, userId: owner.id, userMessage: 'priced' }));
      const done = chunks.find((chunk) => chunk.type === 'done');
      expect(done && done.type === 'done' ? done.usage?.costUsd : undefined).toBe(0.12);
      const reservation = await prisma.chatBudgetReservation.findFirstOrThrow({ where: { workspaceId } });
      expect(reservation.status).toBe('settled');
      expect(Number(reservation.reservedUsd)).toBe(0.05);
      expect(Number(reservation.consumedUsd)).toBe(0.12);
      expect(reservation.consumedTokens).toBe(120);
      expect(reservation.stopCode).toBeNull();
      expect(reservation.settledAt).not.toBeNull();
    });

    it('extends the reservation between rounds and stops the turn with CHAT_BUDGET_EXCEEDED when the cap runs out', async () => {
      usePricing();
      process.env.CHAT_BUDGET_WORKSPACE_MONTHLY_USD = '0.2';
      const { workspaceId, ownerSession } = await newWorkspace();
      const client = new ScriptedClient((call) => toolRound(call));
      setChatLLMClientForTesting(client);
      const chunks = await collect(runChatTurn({ sessionId: ownerSession, userId: owner.id, userMessage: 'keep going' }));
      // Round 0 ($0.12) fits; round 1 is admitted with the last $0.08 of
      // headroom; after it ($0.24 spent) no round 2 is started.
      expect(client.calls).toBe(2);
      const last = chunks.at(-1);
      expect(last).toMatchObject({ type: 'error', code: 'CHAT_BUDGET_EXCEEDED', details: { scope: 'workspace', dimension: 'usd' } });
      const reservation = await prisma.chatBudgetReservation.findFirstOrThrow({ where: { workspaceId } });
      expect(reservation.status).toBe('settled');
      expect(reservation.stopCode).toBe('CHAT_BUDGET_EXCEEDED');
      expect(Number(reservation.consumedUsd)).toBe(0.24);
      expect(Number(reservation.reservedUsd)).toBeCloseTo(0.17, 6);
      // History marks the turn's last reply as incomplete, with the code and usage.
      const lastAssistant = await prisma.chatMessage.findFirstOrThrow({ where: { sessionId: ownerSession, role: 'assistant' }, orderBy: { createdAt: 'desc' } });
      expect(lastAssistant.incomplete).toBe(true);
      expect(lastAssistant.errorCode).toBe('CHAT_BUDGET_EXCEEDED');
      expect(lastAssistant.usage).toMatchObject({ modelCalls: 2, costUsd: 0.24 });
    });

    it('serialises concurrent admissions so the granted reservations never exceed the cap', async () => {
      usePricing();
      process.env.CHAT_BUDGET_WORKSPACE_MONTHLY_USD = '0.1';
      process.env.CHAT_BUDGET_TURN_RESERVE_USD = '0.06';
      const { workspaceId } = await newWorkspace();
      const results = await Promise.all([1, 2, 3].map((n) => admitChatTurn({ workspaceId, userId: owner.id, sessionId: null, turnId: `concurrent-${suffix}-${n}` })));
      const admitted = results.filter((result) => result.ok);
      const refused = results.filter((result) => !result.ok);
      expect(admitted).toHaveLength(2);
      expect(refused).toHaveLength(1);
      if (!refused[0]?.ok && refused[0]) expect(refused[0].refusal.code).toBe('CHAT_BUDGET_EXCEEDED');
      const reserved = (await prisma.chatBudgetReservation.findMany({ where: { workspaceId } })).map((row) => Number(row.reservedUsd)).sort();
      expect(reserved).toEqual([0.04, 0.06]);
      for (const result of admitted) if (result.ok) await result.budget.settle();
    });

    it('applies a member override instead of the workspace per-member default, under the operator ceiling', async () => {
      usePricing();
      const { workspaceId } = await newWorkspace();
      await http().put(`/api/chat/budgets/${workspaceId}`).set('Authorization', `Bearer ${owner.auth}`).send({ perUserMonthlyUsdLimit: 1 }).expect(200);
      await http().put(`/api/chat/budgets/${workspaceId}/members/${member.id}`).set('Authorization', `Bearer ${owner.auth}`).send({ monthlyUsdLimit: 0.01 }).expect(200);
      await seedSpend(workspaceId, member.id, 0.02);
      const memberAdmission = await admitChatTurn({ workspaceId, userId: member.id, sessionId: null, turnId: `member-${suffix}` });
      expect(memberAdmission.ok).toBe(false);
      if (!memberAdmission.ok) {
        expect(memberAdmission.refusal.code).toBe('CHAT_BUDGET_EXCEEDED');
        // The caller's own cap: amounts included.
        expect(memberAdmission.refusal.details).toMatchObject({ scope: 'user', dimension: 'usd', limit: 0.01, spent: 0.02, source: 'member' });
      }
      const ownerAdmission = await admitChatTurn({ workspaceId, userId: owner.id, sessionId: null, turnId: `owner-${suffix}` });
      expect(ownerAdmission.ok).toBe(true);
      if (ownerAdmission.ok) await ownerAdmission.budget.settle();

      // Operator values are ceilings: a workspace can tighten, not loosen.
      process.env.CHAT_BUDGET_USER_MONTHLY_USD = '0.005';
      const config = loadChatBudgetConfig();
      if (!config.ok) throw new Error('config');
      const effective = await resolveEffectiveBudget(workspaceId, member.id, config.config);
      expect(effective.user.usd).toEqual({ value: 0.005, source: 'config' });
      const ownerEffective = await resolveEffectiveBudget(workspaceId, owner.id, config.config);
      expect(ownerEffective.user.usd).toEqual({ value: 0.005, source: 'config' });
    });

    it('enforces token caps without any price configured', async () => {
      process.env.CHAT_BUDGET_USER_MONTHLY_TOKENS = '100';
      const { workspaceId, memberSession } = await newWorkspace();
      await seedSpend(workspaceId, member.id, null, 150);
      const res = await http().post(`/api/chat/sessions/${memberSession}/messages`).set('Authorization', `Bearer ${member.auth}`).send({ content: 'tokens?' });
      expect(res.status).toBe(402);
      expect(res.body.details).toMatchObject({ scope: 'user', dimension: 'tokens', limit: 100, spent: 150 });
    });
  });

  describe('unknown cost', () => {
    it('allows with a budget_warning by default, and blocks once a workspace sets policy block', async () => {
      // No price for the model: USD caps cannot be enforced on this turn.
      process.env.CHAT_BUDGET_WORKSPACE_MONTHLY_USD = '5';
      const { workspaceId, ownerSession } = await newWorkspace();
      setChatLLMClientForTesting(new ScriptedClient(() => answer()));
      const allowed = await http().post(`/api/chat/sessions/${ownerSession}/messages`).set('Authorization', `Bearer ${owner.auth}`).send({ content: 'unpriced' });
      expect(allowed.status).toBe(200);
      expect(allowed.text).toContain('event: budget_warning');
      expect(allowed.text).toContain('CHAT_BUDGET_COST_UNKNOWN');
      expect(allowed.text).toContain('event: done');

      await http().put(`/api/chat/budgets/${workspaceId}`).set('Authorization', `Bearer ${owner.auth}`).send({ unknownCostPolicy: 'block' }).expect(200);
      const blocked = await http().post(`/api/chat/sessions/${ownerSession}/messages`).set('Authorization', `Bearer ${owner.auth}`).send({ content: 'unpriced again' });
      expect(blocked.status).toBe(402);
      expect(blocked.body.code).toBe('CHAT_BUDGET_COST_UNKNOWN');

      // An operator `block` cannot be loosened by a workspace `allow`.
      await http().put(`/api/chat/budgets/${workspaceId}`).set('Authorization', `Bearer ${owner.auth}`).send({ unknownCostPolicy: 'allow' }).expect(200);
      process.env.CHAT_BUDGET_UNKNOWN_COST = 'block';
      const config = loadChatBudgetConfig();
      if (!config.ok) throw new Error('config');
      expect((await resolveEffectiveBudget(workspaceId, owner.id, config.config)).unknownCostPolicy).toBe('block');
    });

    it('stops a block-policy turn before its next round when a call comes back unpriced', async () => {
      usePricing();
      process.env.CHAT_BUDGET_WORKSPACE_MONTHLY_USD = '5';
      process.env.CHAT_BUDGET_UNKNOWN_COST = 'block';
      const { ownerSession } = await newWorkspace();
      // Priced model, but this call reports cache reads without a cache price → unknown.
      const client = new ScriptedClient(() => [
        { type: 'tool_call_delta', index: 0, id: 'call_cache', name: 'list_workspaces', argumentsDelta: '{}' },
        { type: 'done', finishReason: 'tool_calls', usage: { ...usage(), cacheReadTokens: 50 } },
      ]);
      setChatLLMClientForTesting(client);
      const chunks = await collect(runChatTurn({ sessionId: ownerSession, userId: owner.id, userMessage: 'cached' }));
      expect(client.calls).toBe(1);
      expect(chunks.at(-1)).toMatchObject({ type: 'error', code: 'CHAT_BUDGET_COST_UNKNOWN' });
    });
  });

  describe('administration and status', () => {
    it('lets owners/admins set budgets (audited), refuses members, validates input', async () => {
      const { workspaceId } = await newWorkspace();
      const asMember = await http().put(`/api/chat/budgets/${workspaceId}`).set('Authorization', `Bearer ${member.auth}`).send({ monthlyUsdLimit: 1 });
      expect(asMember.status).toBe(403);
      expect((await http().get(`/api/chat/budgets/${workspaceId}`).set('Authorization', `Bearer ${member.auth}`)).status).toBe(403);

      const set = await http().put(`/api/chat/budgets/${workspaceId}`).set('Authorization', `Bearer ${owner.auth}`).send({ monthlyUsdLimit: 12.5, monthlyTokenLimit: 1_000_000 });
      expect(set.status).toBe(200);
      expect(set.body.settings).toMatchObject({ monthlyUsdLimit: 12.5, monthlyTokenLimit: 1_000_000, perUserMonthlyUsdLimit: null, unknownCostPolicy: null, updatedById: owner.id });
      expect(set.body.status.workspace.usd).toMatchObject({ limit: 12.5, source: 'workspace', spent: 0, remaining: 12.5 });
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { workspaceId, action: 'chat.budget_updated' } });
      expect(audit.actorId).toBe(owner.id);

      // Partial update keeps other fields; null clears one.
      const cleared = await http().put(`/api/chat/budgets/${workspaceId}`).set('Authorization', `Bearer ${owner.auth}`).send({ monthlyTokenLimit: null });
      expect(cleared.body.settings).toMatchObject({ monthlyUsdLimit: 12.5, monthlyTokenLimit: null });

      for (const bad of [{ monthlyUsdLimit: -1 }, { monthlyTokenLimit: 1.5 }, { unknownCostPolicy: 'sometimes' }, { surprise: true }, {}, { monthlyUsdLimit: 0.0000001 }]) {
        expect((await http().put(`/api/chat/budgets/${workspaceId}`).set('Authorization', `Bearer ${owner.auth}`).send(bad)).status).toBe(400);
      }

      const stranger = await makeUser(`stranger${randomUUID().slice(0, 4)}`);
      const notMember = await http().put(`/api/chat/budgets/${workspaceId}/members/${stranger.id}`).set('Authorization', `Bearer ${owner.auth}`).send({ monthlyUsdLimit: 1 });
      expect(notMember.status).toBe(404);
      expect(notMember.body.code).toBe('MEMBER_NOT_FOUND');

      const override = await http().put(`/api/chat/budgets/${workspaceId}/members/${member.id}`).set('Authorization', `Bearer ${owner.auth}`).send({ monthlyUsdLimit: 2 });
      expect(override.body.members).toEqual([expect.objectContaining({ userId: member.id, monthlyUsdLimit: 2, monthlyTokenLimit: null })]);
      const removed = await http().put(`/api/chat/budgets/${workspaceId}/members/${member.id}`).set('Authorization', `Bearer ${owner.auth}`).send({ monthlyUsdLimit: null });
      expect(removed.body.members).toEqual([]);
      await expect(prisma.auditLog.count({ where: { workspaceId, action: 'chat.member_budget_updated' } })).resolves.toBe(2);
    });

    it('reports budget status on GET /api/usage/models; workspace amounts only for owners/admins', async () => {
      usePricing();
      process.env.CHAT_BUDGET_WORKSPACE_MONTHLY_USD = '1';
      process.env.CHAT_BUDGET_USER_MONTHLY_USD = '0.5';
      const { workspaceId } = await newWorkspace();
      await seedSpend(workspaceId, member.id, 0.45);
      await seedSpend(workspaceId, owner.id, null);

      const asOwner = await http().get(`/api/usage/models?workspaceId=${workspaceId}`).set('Authorization', `Bearer ${owner.auth}`);
      expect(asOwner.status).toBe(200);
      expect(asOwner.body.budget).toMatchObject({
        workspaceId,
        unknownCostPolicy: 'allow',
        costPriceable: true,
        workspace: { amountsVisible: true, usd: { limit: 1, spent: 0.45, coverage: 'partial', uncountedCalls: 1 }, state: 'ok' },
        user: { amountsVisible: true, usd: { limit: 0.5, spent: 0, remaining: 0.5 }, state: 'ok' },
      });
      expect(asOwner.body.budget.period.start).toMatch(/-01T00:00:00.000Z$/);

      const asMember = await http().get(`/api/usage/models?workspaceId=${workspaceId}`).set('Authorization', `Bearer ${member.auth}`);
      expect(asMember.body.budget.workspace).toEqual({ usd: null, tokens: null, state: 'ok', amountsVisible: false });
      expect(asMember.body.budget.user).toMatchObject({ usd: { limit: 0.5, spent: 0.45, remaining: 0.05 }, state: 'warning' });
      expect(asMember.body.budget.state).toBe('warning');

      // No workspace in scope: no budget.
      const unscoped = await http().get('/api/usage/models').set('Authorization', `Bearer ${member.auth}`);
      expect(unscoped.body.budget).toBeNull();
    });
  });
});
