import { HttpError } from '../errors';
import { redactText } from '../lib/redact-text';
import type { DeliveryEnvelope } from './webhook-events';
import { usesLoopbackTestException } from './webhook-network';

/**
 * FE-14 follow-up: what a delivery body looks like for each receiver. See
 * docs/reports/revamp-2026-10-26/webhooks.md §11.
 *
 *   openlinear  the signed JSON envelope (webhook-events.ts `deliveryBody`);
 *   slack       a Slack incoming-webhook message `{ text, blocks }`;
 *   discord     a Discord webhook message `{ content, embeds, allowed_mentions }`.
 *
 * Slack and Discord bodies are short human messages with a link back to
 * OpenLinear (`FRONTEND_URL`). They carry the same facts as the JSON body
 * and nothing more — titles and names, never descriptions, outcomes, logs,
 * errors or secrets — and every title additionally goes through the export
 * redaction (a pasted token in a title stays out of a chat channel). Text is
 * escaped for the receiver: no mentions (`<!channel>`, `@everyone`), no
 * masked links or formatting smuggled in through a title.
 *
 * A format only accepts its receiver's URLs: `slack` needs
 * `https://hooks.slack.com/services/…`, `discord` needs
 * `https://discord.com/api/webhooks/…` (or discordapp.com). The signature
 * headers are still sent (receivers ignore them); delivery ids and retries
 * are the same for every format.
 */

export const WEBHOOK_FORMATS = ['openlinear', 'slack', 'discord'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export function isWebhookFormat(value: string): value is WebhookFormat {
  return (WEBHOOK_FORMATS as readonly string[]).includes(value);
}

/** The stored value, read defensively (the column has a CHECK). */
export function formatOf(value: string | null | undefined): WebhookFormat {
  return value && isWebhookFormat(value) ? value : 'openlinear';
}

// ── URL rules per format ───────────────────────────────────────────────────

export type WebhookFormatProblem = 'slack_url_required' | 'discord_url_required';

const FORMAT_PROBLEM_TEXT: Record<WebhookFormatProblem, string> = {
  slack_url_required: 'The Slack format needs a Slack incoming webhook URL (https://hooks.slack.com/services/…)',
  discord_url_required: 'The Discord format needs a Discord webhook URL (https://discord.com/api/webhooks/…)',
};

const DISCORD_HOSTS: ReadonlySet<string> = new Set(['discord.com', 'discordapp.com']);

/**
 * Null when `url` (already normalized by `normalizeWebhookUrl`) fits the
 * format. Tests deliver Slack/Discord bodies to a loopback receiver through
 * the explicit test hook.
 */
export function webhookFormatProblem(format: WebhookFormat, rawUrl: string): WebhookFormatProblem | null {
  if (format === 'openlinear') return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return format === 'slack' ? 'slack_url_required' : 'discord_url_required';
  }
  if (usesLoopbackTestException(url)) return null;
  const https = url.protocol === 'https:' && url.port === '';
  const host = url.hostname.toLowerCase();
  if (format === 'slack') {
    return https && host === 'hooks.slack.com' && url.pathname.startsWith('/services/') && url.pathname.length > '/services/'.length ? null : 'slack_url_required';
  }
  return https && DISCORD_HOSTS.has(host) && url.pathname.startsWith('/api/webhooks/') && url.pathname.length > '/api/webhooks/'.length ? null : 'discord_url_required';
}

/** 400 WEBHOOK_URL_INVALID (`details.reason`, `details.format`) when the URL does not fit the format. */
export function assertFormatFitsUrl(format: WebhookFormat, url: string): void {
  const problem = webhookFormatProblem(format, url);
  if (problem) throw new HttpError(400, 'WEBHOOK_URL_INVALID', FORMAT_PROBLEM_TEXT[problem], { field: 'url', reason: problem, format });
}

// ── A format-neutral message ───────────────────────────────────────────────

/** Names the renderer needs that the event data does not carry. */
export interface MessageContext {
  projectName: string | null;
  workspaceName: string | null;
}

interface ChatField {
  name: string;
  value: string;
}

interface ChatLink {
  text: string;
  url: string;
}

/**
 * What a Slack or Discord message says, as plain (unescaped) text. Every
 * string that came from a user (titles, names) is already redacted and
 * shortened; renderers escape all of it.
 */
export interface ChatMessage {
  /** One line with the subject: Slack's notification text. */
  summary: string;
  /** One line without the subject: Discord's message content. */
  headline: string;
  heading: string;
  subject: { text: string; url: string | null } | null;
  details: string[];
  fields: ChatField[];
  links: ChatLink[];
  /** Footer: where it happened. */
  context: string;
  color: number;
  timestamp: string;
}

const TITLE_LIMIT = 200;
const DETAIL_LIMIT = 260;
const COLORS = {
  neutral: 0x8b949e,
  issue: 0x5e6ad2,
  done: 0x2ea043,
  failed: 0xd73a49,
  plan: 0x8250df,
  schedule: 0x0969da,
} as const;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Code-point safe shortening with an ellipsis. */
function clip(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/**
 * Whole lines (already escaped) joined while they fit `limit`; the first
 * line always stays (it is short). Never cuts inside an escape sequence.
 */
function fitLines(lines: string[], limit: number): string {
  let out = lines[0] ?? '';
  for (const line of lines.slice(1)) {
    if (out.length + 1 + line.length > limit) break;
    out = `${out}\n${line}`;
  }
  return out.slice(0, limit);
}

/** A title or name as it may appear in a chat channel: one line, redacted, bounded. */
function userText(value: unknown, fallback: string): string {
  const text = str(value);
  // Clipped before redaction too: redaction cost grows with the input, and only the first characters are shown.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters never reach a chat message.
  return text ? clip(redactText(text.slice(0, TITLE_LIMIT * 4)).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(), TITLE_LIMIT) || fallback : fallback;
}

/** `FRONTEND_URL` (the app people sign in to), without a trailing slash. */
export function webhookAppBaseUrl(): string {
  const raw = process.env.FRONTEND_URL?.trim() || 'http://localhost:3000';
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString().replace(/\/+$/, '');
  } catch {
    // fall through
  }
  return 'http://localhost:3000';
}

function appLink(path: string): string {
  return `${webhookAppBaseUrl()}${path}`;
}

const q = encodeURIComponent;

function issueSubject(issue: Json | null): ChatMessage['subject'] {
  if (!issue) return null;
  const id = str(issue.id);
  const title = userText(issue.title, 'Untitled issue');
  const identifier = str(issue.identifier);
  return { text: identifier ? `${identifier} ${title}` : title, url: id ? appLink(`/?task=${q(id)}`) : null };
}

const STATUS_WORDS: Record<string, string> = { todo: 'Todo', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };

function statusWord(value: unknown): string | null {
  const status = str(value);
  return status ? STATUS_WORDS[status] ?? status : null;
}

/** An http(s) URL safe to place inside Slack `<url|label>` or a Discord `[label](url)`. */
function safeUrl(raw: unknown): string | null {
  const text = str(raw);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString().replace(/[<>|()\s]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  } catch {
    return null;
  }
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface DigestCounts {
  issues: { created: number; completed: number; blocked: number };
  runs: { succeeded: number; failed: number };
  plansAwaitingReview: number;
  knowledgeProposals: number;
}

function countsOf(value: unknown): DigestCounts {
  const record = isRecord(value) ? value : {};
  const issues = isRecord(record.issues) ? record.issues : {};
  const runs = isRecord(record.runs) ? record.runs : {};
  return {
    issues: { created: num(issues.created), completed: num(issues.completed), blocked: num(issues.blocked) },
    runs: { succeeded: num(runs.succeeded), failed: num(runs.failed) },
    plansAwaitingReview: num(record.plansAwaitingReview),
    knowledgeProposals: num(record.knowledgeProposals),
  };
}

/** "3 created, 2 completed, 1 blocked; 4 runs succeeded, 1 failed; 1 plan and 2 knowledge proposals waiting". */
export function digestSentence(counts: DigestCounts): string {
  const parts = [
    `${plural(counts.issues.created, 'issue')} created, ${counts.issues.completed} completed, ${counts.issues.blocked} blocked`,
    `${plural(counts.runs.succeeded, 'run')} succeeded, ${counts.runs.failed} failed`,
  ];
  const waiting = [
    counts.plansAwaitingReview > 0 ? plural(counts.plansAwaitingReview, 'plan') : null,
    counts.knowledgeProposals > 0 ? plural(counts.knowledgeProposals, 'knowledge proposal') : null,
  ].filter((part): part is string => part !== null);
  if (waiting.length > 0) parts.push(`${waiting.join(' and ')} waiting for review`);
  return parts.join('; ');
}

function digestMessage(envelope: DeliveryEnvelope, where: string): Omit<ChatMessage, 'timestamp'> {
  const data = envelope.data;
  const digest = isRecord(data.digest) ? data.digest : {};
  const counts = countsOf(digest);
  const date = str(digest.date) ?? envelope.createdAt.toISOString().slice(0, 10);
  const hour = num(digest.hour);
  const timezone = userText(digest.timezone, 'UTC');
  const workspaceScope = envelope.projectId === null;
  const subjectUrl = envelope.projectId ? appLink(`/projects/board?id=${q(envelope.projectId)}`) : appLink('/');
  const projects = Array.isArray(data.projects) ? data.projects.filter(isRecord) : [];
  const details = workspaceScope
    ? projects.slice(0, 8).map((project) => {
      const each = countsOf(project);
      const name = userText(project.name, 'Project');
      return `${name}: ${each.issues.created} created, ${each.issues.completed} completed, ${each.runs.failed} failed ${each.runs.failed === 1 ? 'run' : 'runs'}`;
    })
    : [];
  if (workspaceScope && projects.length > 8) details.push(`…and ${projects.length - 8} more projects`);
  const links: ChatLink[] = [];
  if (envelope.projectId && counts.plansAwaitingReview > 0) links.push({ text: 'Plans to review', url: appLink(`/projects/plans?id=${q(envelope.projectId)}`) });
  if (envelope.projectId && counts.knowledgeProposals > 0) links.push({ text: 'Knowledge proposals', url: appLink(`/projects/knowledge?id=${q(envelope.projectId)}`) });
  return {
    summary: `Daily digest for ${where}, ${date}: ${digestSentence(counts)}`,
    headline: `Daily digest for ${where}, ${date}`,
    heading: `Daily digest · ${date}`,
    subject: { text: where, url: subjectUrl },
    details,
    fields: [
      { name: 'Issues created', value: String(counts.issues.created) },
      { name: 'Issues completed', value: String(counts.issues.completed) },
      { name: 'Blocked now', value: String(counts.issues.blocked) },
      { name: 'Runs succeeded', value: String(counts.runs.succeeded) },
      { name: 'Runs failed', value: String(counts.runs.failed) },
      { name: 'Plans awaiting review', value: String(counts.plansAwaitingReview) },
      { name: 'Knowledge proposals', value: String(counts.knowledgeProposals) },
    ],
    links,
    // The window runs from the previous day's digest time (23-25 hours across DST changes).
    context: `Since ${String(hour).padStart(2, '0')}:00 yesterday (${timezone}) · OpenLinear`,
    color: COLORS.issue,
  };
}

/**
 * The message for one delivery envelope (any event type, test pings and
 * digests included). Unknown types get a generic line.
 */
export function chatMessage(envelope: DeliveryEnvelope, context: MessageContext): ChatMessage {
  const data = envelope.data;
  const where = context.projectName ? userText(context.projectName, 'a project') : context.workspaceName ? userText(context.workspaceName, 'a workspace') : 'OpenLinear';
  const footer = `${where} · OpenLinear`;
  const issue = isRecord(data.issue) ? data.issue : null;
  const subject = issueSubject(issue);
  const base = { details: [] as string[], fields: [] as ChatField[], links: [] as ChatLink[], context: footer };
  const about = (heading: string, color: number, extra: Partial<Pick<ChatMessage, 'details' | 'links'>> = {}): Omit<ChatMessage, 'timestamp'> => ({
    ...base,
    ...extra,
    summary: subject ? `${heading}: ${subject.text} · ${where}` : `${heading} · ${where}`,
    headline: `${heading} in ${where}`,
    heading,
    subject,
    color,
  });

  let message: Omit<ChatMessage, 'timestamp'>;
  switch (envelope.type) {
    case 'issue.created': {
      const status = statusWord(issue?.status);
      const priority = str(issue?.priority);
      message = about('Issue created', COLORS.issue, { details: [status ? `Status: ${status}` : null, priority ? `Priority: ${priority}` : null].filter((line): line is string => line !== null) });
      break;
    }
    case 'issue.updated': {
      const status = statusWord(issue?.status);
      message = about('Issue updated', COLORS.issue, { details: status ? [`Status: ${status}`] : [] });
      break;
    }
    case 'issue.done':
      message = about('Issue done', COLORS.done, { details: data.source === 'agent' ? ['Completed by an agent run'] : [] });
      break;
    case 'issue.deleted':
      message = { ...about('Issue deleted', COLORS.neutral), subject: null, summary: `An issue was deleted · ${where}`, headline: `Issue deleted in ${where}` };
      break;
    case 'run.succeeded':
    case 'run.failed':
    case 'run.cancelled': {
      const run = isRecord(data.run) ? data.run : {};
      const outcome = envelope.type === 'run.succeeded' ? 'succeeded' : envelope.type === 'run.failed' ? 'failed' : 'was cancelled';
      const runner = str(run.agent);
      const model = str(run.model);
      const pr = safeUrl(run.prUrl ?? issue?.prUrl);
      message = about(`Agent run ${outcome}`, envelope.type === 'run.succeeded' ? COLORS.done : envelope.type === 'run.failed' ? COLORS.failed : COLORS.neutral, {
        details: [runner ? `Runner: ${userText(runner, '')}${model ? ` (${userText(model, '')})` : ''}` : null].filter((line): line is string => line !== null),
        links: pr ? [{ text: 'Pull request', url: pr }] : [],
      });
      break;
    }
    case 'plan.approved': {
      const plan = isRecord(data.plan) ? data.plan : {};
      const planId = str(plan.id);
      const revision = typeof plan.revision === 'number' ? plan.revision : null;
      const planSubject = { text: userText(plan.title, 'Untitled plan'), url: planId && envelope.projectId ? appLink(`/projects/plans?id=${q(envelope.projectId)}&plan=${q(planId)}`) : null };
      message = {
        ...base,
        summary: `Plan approved: ${planSubject.text} · ${where}`,
        headline: `Plan approved in ${where}`,
        heading: 'Plan approved',
        subject: planSubject,
        details: revision !== null ? [`Revision ${revision}`] : [],
        color: COLORS.plan,
      };
      break;
    }
    case 'schedule.fired': {
      const schedule = isRecord(data.schedule) ? data.schedule : {};
      message = about('Recurring issue created', COLORS.schedule, { details: str(schedule.title) ? [`Schedule: ${userText(schedule.title, '')}`] : [] });
      break;
    }
    case 'digest.daily':
      message = digestMessage(envelope, where);
      break;
    case 'ping':
      message = {
        ...base,
        summary: `Test message from OpenLinear · ${where}`,
        headline: `Test message from OpenLinear for ${where}`,
        heading: 'Test message',
        subject: null,
        details: ['This webhook is connected. The events you picked will be posted here.'],
        color: COLORS.neutral,
      };
      break;
    default:
      message = { ...about(`OpenLinear event ${clip(envelope.type, 64)}`, COLORS.neutral) };
  }
  return { ...message, timestamp: envelope.createdAt.toISOString() };
}

// ── Slack ──────────────────────────────────────────────────────────────────

/** Slack's three control characters; with them escaped no `<!channel>`, `<@U…>` or `<url|label>` can be formed. */
function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * `{ text, blocks }` for a Slack incoming webhook: `text` is the
 * notification line, the blocks show the subject, details, numbers and
 * links. No interactive elements (they need a Slack app).
 */
export function slackBody(message: ChatMessage): string {
  const lines = [`*${slackEscape(message.heading)}*`];
  if (message.subject) lines.push(slackEscape(message.subject.text));
  for (const detail of message.details) lines.push(slackEscape(clip(detail, DETAIL_LIMIT)));
  const links = [
    ...(message.subject?.url ? [{ text: 'Open in OpenLinear', url: message.subject.url }] : []),
    ...message.links,
  ].flatMap((link) => {
    const url = safeUrl(link.url);
    return url ? [`<${url}|${slackEscape(link.text)}>`] : [];
  });
  if (links.length > 0) lines.push(links.join(' · '));
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: fitLines(lines, 3000) } }];
  if (message.fields.length > 0) {
    blocks.push({
      type: 'section',
      fields: message.fields.slice(0, 10).map((field) => ({ type: 'mrkdwn', text: `*${slackEscape(field.name)}*\n${slackEscape(field.value)}` })),
    });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: slackEscape(message.context) }] });
  return JSON.stringify({ text: slackEscape(message.summary), blocks });
}

// ── Discord ────────────────────────────────────────────────────────────────

/**
 * Backslash before every Markdown-significant character, so a title cannot
 * format, link (`[x](…)`), quote, mention or form an emoji; Discord drops
 * the backslash when rendering.
 */
function discordEscape(text: string): string {
  return text.replace(/[\\*_~`|>#\-[\]()<@:!]/g, '\\$&');
}

/**
 * `{ content, embeds, allowed_mentions }` for a Discord webhook: the
 * content line names the event and where; the embed links the subject and
 * lists details and numbers. `allowed_mentions.parse = []` makes sure
 * nothing in the message can ping anyone.
 */
export function discordBody(message: ChatMessage): string {
  const description = fitLines([
    ...message.details.map((detail) => discordEscape(clip(detail, DETAIL_LIMIT))),
    ...message.links.flatMap((link) => {
      const url = safeUrl(link.url);
      return url ? [`[${discordEscape(link.text)}](${url})`] : [];
    }),
  ], 4096);
  const subjectUrl = message.subject?.url ? safeUrl(message.subject.url) : null;
  const embed = {
    // Escaping at most doubles a string: clip first, so no escape is cut in half.
    ...(message.subject ? { title: discordEscape(clip(message.subject.text, 128)), ...(subjectUrl ? { url: subjectUrl } : {}) } : {}),
    ...(description ? { description } : {}),
    color: message.color,
    ...(message.fields.length > 0
      ? { fields: message.fields.slice(0, 25).map((field) => ({ name: discordEscape(clip(field.name, 128)), value: discordEscape(clip(field.value, 512)), inline: true })) }
      : {}),
    // Footers are plain text (no Markdown, no mentions).
    footer: { text: clip(message.context, 2048) },
    timestamp: message.timestamp,
  };
  return JSON.stringify({
    content: discordEscape(clip(message.headline, 1000)),
    embeds: [embed],
    allowed_mentions: { parse: [] },
  });
}

/** The body of a Slack or Discord delivery (the JSON format lives in webhook-events.ts). */
export function chatBody(format: Exclude<WebhookFormat, 'openlinear'>, envelope: DeliveryEnvelope, context: MessageContext): string {
  const message = chatMessage(envelope, context);
  return format === 'slack' ? slackBody(message) : discordBody(message);
}
