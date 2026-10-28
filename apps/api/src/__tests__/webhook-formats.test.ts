/**
 * FE-14 follow-up, pure parts: which URLs each body format accepts, the
 * Slack / Discord messages (titles only, redacted, escaped so a title can
 * neither mention, link nor format), and the daily-digest slot and settings
 * math (DST days included). No database, no network.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DIGEST_HOUR, DEFAULT_DIGEST_TIMEZONE, digestEventId, digestSettings, digestSlot, resolveDigestTimeZone } from '../services/webhook-digest';
import type { DeliveryEnvelope } from '../services/webhook-events';
import { chatBody, chatMessage, digestSentence, formatOf, webhookAppBaseUrl, webhookFormatProblem } from '../services/webhook-formats';
import { allowLoopbackWebhooksForTests } from '../services/webhook-network';

const GH = `ghp_${'A'.repeat(36)}`;
const NASTY = `<!channel> @everyone *bold* [click](https://evil.example) <https://evil.example|x> & ${GH}`;
const context = { projectName: 'Acme <Web>', workspaceName: null };

function envelope(type: string, data: Record<string, unknown>, overrides: Partial<DeliveryEnvelope> = {}): DeliveryEnvelope {
  return { deliveryId: 'd1', type, createdAt: new Date('2026-10-27T10:00:00.000Z'), projectId: 'p1', workspaceId: 'w1', data, ...overrides };
}

const issue = { id: 't-1', identifier: 'ENG-12', title: NASTY, status: 'in_progress', priority: 'high', description: 'private notes', projectId: 'p1' };

const originalFrontendUrl = process.env.FRONTEND_URL;
beforeEach(() => {
  delete process.env.FRONTEND_URL;
});
afterEach(() => {
  allowLoopbackWebhooksForTests(false);
});
afterAll(() => {
  if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = originalFrontendUrl;
});

describe('webhook body formats: URL rules', () => {
  it('accepts only Slack incoming-webhook URLs for slack and Discord webhook URLs for discord', () => {
    expect(webhookFormatProblem('openlinear', 'https://example.com/hook')).toBeNull();
    expect(webhookFormatProblem('slack', 'https://hooks.slack.com/services/T000/B000/XXXX')).toBeNull();
    for (const url of [
      'https://example.com/services/T/B/X',
      'https://hooks.slack.com/workflows/T/A/1',
      'https://hooks.slack.com/services/',
      'https://hooks.slack.com:8443/services/T/B/X',
      'https://hooks.slack.com.evil.example/services/T/B/X',
      'http://hooks.slack.com/services/T/B/X',
      'not a url',
    ]) expect(webhookFormatProblem('slack', url), url).toBe('slack_url_required');
    expect(webhookFormatProblem('discord', 'https://discord.com/api/webhooks/123/abc')).toBeNull();
    expect(webhookFormatProblem('discord', 'https://discordapp.com/api/webhooks/123/abc?thread_id=9')).toBeNull();
    for (const url of [
      'https://discord.com/channels/1/2',
      'https://discord.com/api/webhooks/',
      'https://evil.example/api/webhooks/1/x',
      'https://hooks.slack.com/services/T/B/X',
    ]) expect(webhookFormatProblem('discord', url), url).toBe('discord_url_required');
    expect(formatOf('slack')).toBe('slack');
    expect(formatOf('teams')).toBe('openlinear');
    expect(formatOf(null)).toBe('openlinear');
  });

  it('lets tests use a loopback receiver for every format only through the explicit hook', () => {
    expect(webhookFormatProblem('slack', 'http://127.0.0.1:9/services/T/B/X')).toBe('slack_url_required');
    allowLoopbackWebhooksForTests(true);
    expect(webhookFormatProblem('slack', 'http://127.0.0.1:9/anything')).toBeNull();
    expect(webhookFormatProblem('discord', 'http://127.0.0.1:9/anything')).toBeNull();
    expect(webhookFormatProblem('slack', 'https://example.com/anything')).toBe('slack_url_required');
  });
});

describe('webhook body formats: Slack', () => {
  it('posts { text, blocks } with the title escaped and redacted, a link back, and nothing else', () => {
    process.env.FRONTEND_URL = 'https://app.openlinear.test/';
    const body = JSON.parse(chatBody('slack', envelope('issue.created', { issue }), context)) as { text: string; blocks: Array<Record<string, unknown>> };
    expect(Object.keys(body)).toEqual(['text', 'blocks']);
    const raw = JSON.stringify(body);
    // No mention, link or entity can be formed from the title; secrets and descriptions never appear.
    expect(raw).not.toContain('<!channel>');
    expect(raw).not.toContain('<https://evil.example');
    expect(raw).toContain('&lt;!channel&gt;');
    expect(raw).toContain('&amp; [redacted]');
    expect(raw).not.toContain(GH);
    expect(raw).not.toContain('private notes');
    expect(body.text).toMatch(/^Issue created: ENG-12 &lt;!channel&gt;/);
    expect(body.text).toContain('· Acme &lt;Web&gt;');
    const section = body.blocks[0] as { type: string; text: { type: string; text: string } };
    expect(section).toMatchObject({ type: 'section', text: { type: 'mrkdwn' } });
    expect(section.text.text).toContain('*Issue created*');
    expect(section.text.text).toContain('Status: In progress');
    expect(section.text.text).toContain('<https://app.openlinear.test/?task=t-1|Open in OpenLinear>');
    expect(body.blocks.at(-1)).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Acme &lt;Web&gt; · OpenLinear' }] });
  });

  it('words every event type, with links only to OpenLinear and the pull request', () => {
    const message = (type: string, data: Record<string, unknown>) => chatMessage(envelope(type, data), context);
    expect(message('issue.done', { issue, source: 'agent' })).toMatchObject({ heading: 'Issue done', details: ['Completed by an agent run'] });
    expect(message('issue.deleted', { issue: { id: 't-1' } })).toMatchObject({ heading: 'Issue deleted', subject: null, summary: 'An issue was deleted · Acme <Web>' });
    const failed = message('run.failed', { issue, run: { id: 'r1', agent: 'claude-code', model: 'sonnet', status: 'failed', prUrl: 'https://github.com/acme/web/pull/7' } });
    expect(failed).toMatchObject({ heading: 'Agent run failed', details: ['Runner: claude-code (sonnet)'], links: [{ text: 'Pull request', url: 'https://github.com/acme/web/pull/7' }] });
    expect(message('run.succeeded', { issue, run: { prUrl: 'javascript:alert(1)' } }).links).toEqual([]);
    expect(message('run.cancelled', { issue, run: {} }).heading).toBe('Agent run was cancelled');
    expect(message('plan.approved', { plan: { id: 'pl1', title: 'Launch plan', revision: 3 } })).toMatchObject({
      heading: 'Plan approved', subject: { text: 'Launch plan', url: 'http://localhost:3000/projects/plans?id=p1&plan=pl1' }, details: ['Revision 3'],
    });
    expect(message('schedule.fired', { issue, schedule: { id: 's1', title: 'Weekly triage' } }).details).toEqual(['Schedule: Weekly triage']);
    expect(message('ping', { webhookId: 'w' })).toMatchObject({ heading: 'Test message', subject: null });
    expect(message('something.new', {}).heading).toBe('OpenLinear event something.new');
    expect(webhookAppBaseUrl()).toBe('http://localhost:3000');
    process.env.FRONTEND_URL = 'javascript:alert(1)';
    expect(webhookAppBaseUrl()).toBe('http://localhost:3000');
  });
});

describe('webhook body formats: Discord', () => {
  it('posts { content, embeds, allowed_mentions } that can ping nobody and render no Markdown from titles', () => {
    const body = JSON.parse(chatBody('discord', envelope('run.failed', { issue, run: { agent: 'codex', prUrl: 'https://github.com/acme/web/pull/7' } }), context)) as {
      content: string; embeds: Array<Record<string, unknown>>; allowed_mentions: { parse: string[] };
    };
    expect(Object.keys(body)).toEqual(['content', 'embeds', 'allowed_mentions']);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toBe('Agent run failed in Acme \\<Web\\>');
    const [embed] = body.embeds;
    expect(embed?.url).toBe('http://localhost:3000/?task=t-1');
    const title = String(embed?.title);
    expect(title.startsWith('ENG\\-12 \\<\\!channel\\> \\@everyone \\*bold\\* \\[click\\]\\(https\\:')).toBe(true);
    expect(title).not.toContain(GH);
    expect(embed?.description).toBe('Runner\\: codex\n[Pull request](https://github.com/acme/web/pull/7)');
    expect(embed?.footer).toEqual({ text: 'Acme <Web> · OpenLinear' });
    expect(JSON.stringify(body)).not.toContain('private notes');
  });

  it('keeps every part inside Discord limits even for long titles', () => {
    const long = { ...issue, title: '*'.repeat(5_000) };
    const body = JSON.parse(chatBody('discord', envelope('issue.created', { issue: long }), context)) as { content: string; embeds: Array<{ title: string }> };
    expect(body.embeds[0]?.title.length).toBeLessThanOrEqual(256);
    expect(body.content.length).toBeLessThanOrEqual(2000);
    // Clipped before escaping: no dangling backslash.
    expect(body.embeds[0]?.title.endsWith('…')).toBe(true);
  });
});

describe('daily digest: messages and timing', () => {
  const counts = { issues: { created: 3, completed: 2, blocked: 1 }, runs: { succeeded: 4, failed: 1 }, plansAwaitingReview: 1, knowledgeProposals: 2 };

  it('summarizes a project digest readably in Slack and Discord', () => {
    expect(digestSentence(counts)).toBe('3 issues created, 2 completed, 1 blocked; 4 runs succeeded, 1 failed; 1 plan and 2 knowledge proposals waiting for review');
    const digest = envelope('digest.daily', { digest: { date: '2026-10-27', timezone: 'Europe/Berlin', hour: 9, ...counts }, project: { id: 'p1', name: 'Acme <Web>' } });
    const slack = JSON.parse(chatBody('slack', digest, context)) as { text: string; blocks: Array<{ type: string; fields?: Array<{ text: string }>; elements?: Array<{ text: string }> }> };
    expect(slack.text).toBe('Daily digest for Acme &lt;Web&gt;, 2026-10-27: 3 issues created, 2 completed, 1 blocked; 4 runs succeeded, 1 failed; 1 plan and 2 knowledge proposals waiting for review');
    expect(slack.blocks[1]?.fields?.map((field) => field.text)).toContain('*Runs failed*\n1');
    expect(slack.blocks.at(-1)?.elements?.[0]?.text).toBe('Since 09:00 yesterday (Europe/Berlin) · OpenLinear');
    expect(JSON.stringify(slack)).toContain('/projects/plans?id=p1|Plans to review>');
    const discord = JSON.parse(chatBody('discord', digest, context)) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> };
    expect(discord.embeds[0]?.fields).toHaveLength(7);
    expect(discord.embeds[0]?.fields[0]).toEqual({ name: 'Issues created', value: '3', inline: true });
  });

  it('lists the most active projects in a workspace digest', () => {
    const projects = Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, name: `Project ${index}`, ...counts }));
    const message = chatMessage(envelope('digest.daily', { digest: { date: '2026-10-27', hour: 9, timezone: 'UTC', ...counts }, projects }, { projectId: null }), { projectName: null, workspaceName: 'Acme' });
    expect(message.subject).toEqual({ text: 'Acme', url: 'http://localhost:3000/' });
    expect(message.details).toHaveLength(9);
    expect(message.details[0]).toBe('Project 0: 3 created, 2 completed, 1 failed run');
    expect(message.details.at(-1)).toBe('…and 2 more projects');
  });

  it('computes the window from the previous slot, across daylight-saving changes', () => {
    // Europe/Berlin leaves summer time on 2026-10-25: that day's window is 25 hours.
    const fallBack = digestSlot(9, 'Europe/Berlin', new Date('2026-10-25T12:00:00Z'));
    expect(fallBack).toEqual({
      slotAt: new Date('2026-10-25T08:00:00Z'), since: new Date('2026-10-24T07:00:00Z'), localDate: '2026-10-25', nextAt: new Date('2026-10-26T08:00:00Z'),
    });
    // Before the hour: yesterday's digest is the latest one.
    expect(digestSlot(9, 'Europe/Berlin', new Date('2026-10-27T07:59:00Z')).localDate).toBe('2026-10-26');
    // New York skips 02:00-03:00 on 2026-03-08: a 02:00 digest goes out at 03:00 local.
    const spring = digestSlot(2, 'America/New_York', new Date('2026-03-08T12:00:00Z'));
    expect(spring.slotAt).toEqual(new Date('2026-03-08T07:00:00Z'));
    expect(spring.localDate).toBe('2026-03-08');
    expect(digestEventId(spring.localDate)).toBe('digest.daily:2026-03-08');
  });

  it('derives the digest columns: defaults, kept due time, recomputed on change, none while off', () => {
    const now = new Date('2026-10-27T10:30:00Z');
    expect(digestSettings({ eventTypes: ['digest.daily'], active: true, now })).toEqual({
      digestHour: DEFAULT_DIGEST_HOUR, digestTimezone: DEFAULT_DIGEST_TIMEZONE, digestNextAt: new Date('2026-10-28T09:00:00Z'),
    });
    expect(digestSettings({ eventTypes: ['issue.created'], active: true, now })).toEqual({ digestHour: null, digestTimezone: null, digestNextAt: null });
    expect(digestSettings({ eventTypes: ['issue.created'], active: true, hour: 7, now })).toEqual({ digestHour: 7, digestTimezone: 'UTC', digestNextAt: null });
    const previous = { eventTypes: ['digest.daily'], active: true, digestHour: 9, digestTimezone: 'UTC', digestNextAt: new Date('2026-10-27T09:00:00Z') };
    expect(digestSettings({ eventTypes: ['digest.daily', 'issue.done'], active: true, previous, now }).digestNextAt).toEqual(previous.digestNextAt);
    expect(digestSettings({ eventTypes: ['digest.daily'], active: true, hour: 18, previous, now }).digestNextAt).toEqual(new Date('2026-10-27T18:00:00Z'));
    expect(digestSettings({ eventTypes: ['digest.daily'], active: false, previous, now }).digestNextAt).toBeNull();
    expect(digestSettings({ eventTypes: ['digest.daily'], active: true, previous: { ...previous, active: false }, now }).digestNextAt).toEqual(new Date('2026-10-28T09:00:00Z'));
    expect(resolveDigestTimeZone('europe/berlin')).toBe('Europe/Berlin');
    expect(() => resolveDigestTimeZone('+05:30')).toThrow(/Unknown time zone/);
  });
});

describe('security review fix: hostile titles render fast', () => {
  it('a 240 KB title of `a.` / `a-` runs renders in well under a second and is clipped', async () => {
    const { redactText } = await import('../lib/redact-text');
    const started = Date.now();
    redactText('a.'.repeat(120_000));
    redactText('a-'.repeat(120_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
