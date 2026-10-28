/**
 * W16b ablation corpus: a small, made-up product repository ("Acme Tasks":
 * TypeScript API and web app, a Go worker, Python models, a Rust CLI, docs
 * and tests) and tasks written the way people file them, each labelled with
 * the file(s) an agent would have to change. Several tasks name the area by
 * its file or folder; most describe the symptom in words the file's path
 * does not contain — that is what symbols and content are for.
 */

export const ABLATION_FILES: Readonly<Record<string, string>> = {
  'README.md': `# Acme Tasks

Task tracking for small teams: boards, recurring tasks, invoices and a sync worker.

## Development

Run \`pnpm dev\` for the API and the web app, \`go run ./worker\` for the worker.
`,
  'docs/architecture.md': `# Architecture

## Overview
The API (src/api) serves the web app (web/). A Go worker syncs calendars and drains the job queue.

## Billing
Invoices are rendered by the API; Stripe webhooks update subscriptions.

## Sync worker
The worker polls calendars and enqueues jobs with a visibility timeout.
`,
  'docs/runbooks/oncall.md': `# On-call runbook

## Paging
Incidents page the primary on-call. Acknowledge within 15 minutes.

## Rate limits
If customers report HTTP 429 responses, check the rate limiter dashboards first.
`,
  'src/auth/session.ts': `import { signJwt, verifyJwt } from './jwt';

export const SESSION_TTL_MS = 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface Session {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export function isSessionExpired(session: Session, now = Date.now()): boolean {
  return session.expiresAt <= now;
}

/** Renews the access token shortly before it expires so users stay signed in. */
export async function refreshAccessToken(session: Session, now = Date.now()): Promise<Session> {
  if (session.expiresAt - now > REFRESH_MARGIN_MS) return session;
  const claims = await verifyJwt(session.refreshToken);
  const accessToken = await signJwt({ sub: claims.sub }, SESSION_TTL_MS);
  return { ...session, accessToken, expiresAt: now + SESSION_TTL_MS };
}

export function signOut(session: Session): void {
  session.refreshToken = '';
}
`,
  'src/auth/oauth-github.ts': `import { randomBytes } from 'node:crypto';

const pendingStates = new Map<string, number>();

export function githubAuthorizeUrl(clientId: string): string {
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  return \`https://github.com/login/oauth/authorize?client_id=\${clientId}&state=\${state}\`;
}

export async function githubCallback(code: string, state: string): Promise<string> {
  if (!pendingStates.delete(state)) throw new Error('OAuth state mismatch');
  return exchangeCodeForToken(code);
}

async function exchangeCodeForToken(code: string): Promise<string> {
  const response = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', body: JSON.stringify({ code }) });
  const body = await response.json();
  return body.access_token;
}
`,
  'src/auth/password.ts': `import bcrypt from 'bcrypt';

export const PASSWORD_MIN_LENGTH = 12;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < PASSWORD_MIN_LENGTH) throw new Error('Password too short');
  return bcrypt.hash(plain, 12);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
`,
  'src/auth/two-factor.ts': `import { authenticator } from 'otplib';

export function verifyTotp(secret: string, code: string): boolean {
  return authenticator.check(code, secret);
}

export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => Math.random().toString(36).slice(2, 10));
}
`,
  'src/billing/invoice.ts': `import PDFDocument from 'pdfkit';

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

/** VAT is charged on the net amount of every line. */
export function computeTax(lines: InvoiceLine[], vatRate: number): number {
  const net = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
  return Math.round(net * vatRate);
}

export function renderInvoicePdf(lines: InvoiceLine[], vatRate: number): Buffer {
  const doc = new PDFDocument();
  for (const line of lines) doc.text(\`\${line.description} x\${line.quantity}\`);
  doc.text(\`VAT: \${computeTax(lines, vatRate) / 100}\`);
  doc.end();
  return doc.read();
}
`,
  'src/billing/stripe-webhook.ts': `import type Stripe from 'stripe';
import { markSubscription } from './subscriptions';

/** Applies Stripe events to our subscriptions. */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'invoice.paid':
      await markSubscription(event.data.object, 'active');
      break;
    case 'invoice.payment_failed':
      // card declined: the customer keeps access until the retry schedule ends
      break;
    case 'customer.subscription.deleted':
      await markSubscription(event.data.object, 'cancelled');
      break;
  }
}
`,
  'src/billing/proration.ts': `export function daysRemaining(periodEnd: Date, now = new Date()): number {
  return Math.max(0, Math.ceil((periodEnd.getTime() - now.getTime()) / 86_400_000));
}

/** Credit for the unused part of the old plan when switching mid-period. */
export function prorateSubscriptionChange(oldPriceCents: number, newPriceCents: number, periodEnd: Date): number {
  const days = daysRemaining(periodEnd);
  return Math.round(((newPriceCents - oldPriceCents) * days) / 30);
}
`,
  'src/notifications/email.ts': `import nodemailer from 'nodemailer';

const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: 587 });

export function renderTemplate(name: string, data: Record<string, string>): string {
  return Object.entries(data).reduce((html, [key, value]) => html.replaceAll(\`{{\${key}}}\`, value), name);
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  await transport.sendMail({ to, subject, html, headers: { 'List-Unsubscribe': '<mailto:unsubscribe@acme.test>' } });
}
`,
  'src/notifications/digest.ts': `import { sendEmail } from './email';

interface DigestItem {
  projectId: string;
  projectName: string;
  title: string;
}

export function groupByProject(items: DigestItem[]): Map<string, DigestItem[]> {
  const groups = new Map<string, DigestItem[]>();
  for (const item of items) {
    const list = groups.get(item.projectName) ?? [];
    list.push(item);
    groups.set(item.projectName, list);
  }
  return groups;
}

/** The daily summary email: yesterday's changes grouped under each project. */
export async function buildDailyDigest(userEmail: string, items: DigestItem[]): Promise<void> {
  const sections = [...groupByProject(items)].map(([project, list]) => \`<h2>\${project}</h2>\${list.map((i) => i.title).join('<br>')}\`);
  await sendEmail(userEmail, 'Your daily summary', sections.join(''));
}
`,
  'src/notifications/push.ts': `export interface PushTarget {
  platform: 'apns' | 'fcm';
  deviceToken: string;
}

export async function sendPushNotification(target: PushTarget, title: string, body: string): Promise<void> {
  const endpoint = target.platform === 'apns' ? 'https://api.push.apple.com' : 'https://fcm.googleapis.com/fcm/send';
  await fetch(endpoint, { method: 'POST', body: JSON.stringify({ to: target.deviceToken, title, body }) });
}
`,
  'src/tasks/board.ts': `export interface Column {
  id: string;
  taskIds: string[];
}

/** Moves a card between kanban columns, keeping the drop index. */
export function moveTaskBetweenColumns(from: Column, to: Column, taskId: string, index: number): void {
  from.taskIds = from.taskIds.filter((id) => id !== taskId);
  to.taskIds.push(taskId);
}

export function reorderColumn(column: Column, fromIndex: number, toIndex: number): void {
  const [moved] = column.taskIds.splice(fromIndex, 1);
  column.taskIds.splice(toIndex, 0, moved);
}
`,
  'src/tasks/search.ts': `import { db } from '../db/client';

/** Full-text search over titles with trigram similarity as a fallback. */
export async function searchTasks(query: string, projectId: string) {
  return db.$queryRaw\`SELECT id, title FROM tasks WHERE project_id = \${projectId} AND similarity(title, \${query}) > 0.3\`;
}
`,
  'src/tasks/import-csv.ts': `export interface ImportedTask {
  title: string;
  dueDate: string | null;
}

export function parseCsvRow(line: string, delimiter = ','): string[] {
  return line.split(delimiter).map((cell) => cell.trim());
}

export function importTasksFromCsv(text: string): ImportedTask[] {
  const [header, ...rows] = text.split('\\n');
  const columns = parseCsvRow(header);
  return rows.filter(Boolean).map((row) => {
    const cells = parseCsvRow(row);
    return { title: cells[columns.indexOf('title')], dueDate: cells[columns.indexOf('due')] ?? null };
  });
}
`,
  'src/tasks/recurrence.ts': `import { RRule } from 'rrule';

/** The next date a repeating task is due (daily, weekly, monthly rules). */
export function nextOccurrence(rule: string, after: Date): Date | null {
  const parsed = RRule.fromString(rule);
  return parsed.after(after, false);
}

export function describeRule(rule: string): string {
  return RRule.fromString(rule).toText();
}
`,
  'src/tasks/labels.ts': `export const LABEL_COLORS = ['#e11d48', '#2563eb', '#16a34a'];

export function attachLabel(taskId: string, labelId: string, links: Set<string>): void {
  links.add(\`\${taskId}:\${labelId}\`);
}

export function detachLabel(taskId: string, labelId: string, links: Set<string>): void {
  links.delete(\`\${taskId}:\${labelId}\`);
}
`,
  'src/api/routes/tasks.ts': `import { Router } from 'express';
import { searchTasks } from '../../tasks/search';

export const tasksRouter = Router();

tasksRouter.get('/tasks', async (req, res) => {
  res.json(await searchTasks(String(req.query.q ?? ''), String(req.query.projectId)));
});

tasksRouter.patch('/tasks/bulk', async (req, res) => {
  res.json({ updated: req.body.ids.length });
});
`,
  'src/api/routes/users.ts': `import { Router } from 'express';
import { uploadAvatar } from '../../storage/s3-upload';

export const usersRouter = Router();

usersRouter.put('/users/me/avatar', async (req, res) => {
  res.json({ url: await uploadAvatar(req.body) });
});

usersRouter.patch('/users/me', async (req, res) => {
  res.json({ displayName: req.body.displayName });
});
`,
  'src/api/middleware/rate-limit.ts': `import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/** Token bucket per user: 60 requests per minute, HTTP 429 when empty. */
export function createRateLimiter(capacity = 60, refillPerSecond = 1) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? 'anonymous';
    const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: Date.now() };
    bucket.tokens = Math.min(capacity, bucket.tokens + ((Date.now() - bucket.updatedAt) / 1000) * refillPerSecond);
    bucket.updatedAt = Date.now();
    if (bucket.tokens < 1) return res.status(429).json({ error: 'Too many requests' });
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    next();
  };
}
`,
  'src/api/middleware/cors.ts': `import cors from 'cors';

export const allowedOrigins = ['https://app.acme.test'];

export const corsMiddleware = cors({ origin: allowedOrigins, credentials: true, preflightContinue: false });
`,
  'src/storage/s3-upload.ts': `import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Stores a profile picture; images above MAX_AVATAR_BYTES are rejected. */
export async function uploadAvatar(image: Buffer): Promise<string> {
  if (image.length > MAX_AVATAR_BYTES) throw new Error('Image too large');
  await s3.send(new PutObjectCommand({ Bucket: 'avatars', Key: 'me.png', Body: image }));
  return 'https://cdn.acme.test/avatars/me.png';
}
`,
  'src/storage/cache.ts': `export class LruCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly capacity: number, private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt < Date.now()) return undefined;
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.entries.size >= this.capacity) this.evictOldest();
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  private evictOldest(): void {
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) this.entries.delete(oldest);
  }
}
`,
  'src/db/migrations/0003_add_due_dates.sql': `ALTER TABLE tasks ADD COLUMN due_date timestamptz;
CREATE INDEX tasks_due_date_idx ON tasks (due_date);
`,
  'src/db/schema.prisma': `model User {
  id    String @id
  email String @unique
}

model Task {
  id        String    @id
  title     String
  dueDate   DateTime?
  projectId String
}

model Invoice {
  id          String @id
  totalCents  Int
}
`,
  'src/util/dates.ts': `/** "3 days ago", "in 2 hours" in the user's time zone. */
export function formatRelativeTime(date: Date, now = new Date(), timeZone = 'UTC'): string {
  const diff = Math.round((date.getTime() - now.getTime()) / 3_600_000);
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(diff, 'hour') + \` (\${timeZone})\`;
}

export function parseIsoDate(value: string): Date {
  return new Date(value);
}
`,
  'src/util/retry.ts': `/** Retries an async call with exponential backoff and jitter (webhook deliveries, sync calls). */
export async function withExponentialBackoff<T>(call: () => Promise<T>, attempts = 5, baseMs = 500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      const jitter = Math.random() * baseMs;
      await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** attempt + jitter));
    }
  }
  throw lastError;
}
`,
  'web/components/DatePicker.tsx': `import { useState } from 'react';

export function DatePicker({ value, onChange }: { value: Date; onChange: (date: Date) => void }) {
  const [month, setMonth] = useState(value.getMonth());
  return (
    <div role="grid" aria-label="Calendar">
      <button onClick={() => setMonth(month - 1)}>Previous month</button>
      <button onClick={() => setMonth(month + 1)}>Next month</button>
      {/* days are clickable only; arrow keys do nothing yet */}
      <div onClick={() => onChange(new Date(value.getFullYear(), month, 1))}>1</div>
    </div>
  );
}
`,
  'web/components/AvatarUploader.tsx': `import { useCallback } from 'react';

export function AvatarUploader({ onUpload }: { onUpload: (file: File) => void }) {
  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) onUpload(file);
  }, [onUpload]);
  return <div onDrop={onDrop}>Drop a profile picture here, then crop it</div>;
}
`,
  'web/components/TaskCard.tsx': `export function TaskCard({ title, priority }: { title: string; priority: 'low' | 'medium' | 'high' }) {
  return (
    <article draggable className="card">
      <span className={\`badge badge-\${priority}\`}>{priority}</span>
      <h3>{title}</h3>
    </article>
  );
}
`,
  'web/hooks/useInfiniteScroll.ts': `import { useEffect, useRef } from 'react';

export function useInfiniteScroll(onEnd: () => void) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && onEnd());
    if (sentinel.current) observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [onEnd]);
  return sentinel;
}
`,
  'web/pages/settings/notifications.tsx': `import { useState } from 'react';

/** Per-project notification preferences: email digest and push. */
export default function NotificationSettings({ projects }: { projects: Array<{ id: string; name: string }> }) {
  const [emailDigest, setEmailDigest] = useState(true);
  return (
    <form>
      <label><input type="checkbox" checked={emailDigest} onChange={(e) => setEmailDigest(e.target.checked)} /> Daily email</label>
      {projects.map((project) => <label key={project.id}><input type="checkbox" /> Push for {project.name}</label>)}
    </form>
  );
}
`,
  'worker/sync.go': `package worker

import "context"

// CalendarEvent mirrors one Google Calendar event.
type CalendarEvent struct {
	ID   string
	ETag string
}

// SyncCalendar pulls changed events and upserts them; an event whose ETag
// changed is inserted again instead of updated.
func SyncCalendar(ctx context.Context, events []CalendarEvent, store map[string]CalendarEvent) {
	for _, event := range events {
		if existing, ok := store[event.ID+event.ETag]; ok && existing.ETag == event.ETag {
			continue
		}
		store[event.ID+event.ETag] = event
	}
}
`,
  'worker/queue.go': `package worker

import "time"

// VisibilityTimeout hides a dequeued job from other workers.
const VisibilityTimeout = 30 * time.Second

type Job struct {
	ID      string
	Payload []byte
}

func Enqueue(queue chan Job, job Job) { queue <- job }

func Dequeue(queue chan Job) Job { return <-queue }
`,
  'ml/classify_priority.py': `from sklearn.linear_model import LogisticRegression

LABELS = ["low", "medium", "high"]


class PriorityModel:
    """Guesses an issue's priority from its title and description."""

    def __init__(self):
        self.model = LogisticRegression()

    def predict(self, text: str) -> str:
        return LABELS[1]


def classify_priority(text: str) -> str:
    return PriorityModel().predict(text)
`,
  'ml/dedupe.py': `def shingles(text: str, size: int = 3) -> set:
    words = text.lower().split()
    return {" ".join(words[i:i + size]) for i in range(max(1, len(words) - size + 1))}


def find_duplicates(titles: list, threshold: float = 0.8) -> list:
    """Pairs of issue titles whose shingle overlap (Jaccard) is above the threshold."""
    pairs = []
    for i, a in enumerate(titles):
        for b in titles[i + 1:]:
            sa, sb = shingles(a), shingles(b)
            if len(sa & sb) / max(1, len(sa | sb)) >= threshold:
                pairs.append((a, b))
    return pairs
`,
  'cli/src/main.rs': `mod export;

use clap::Parser;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    project: String,
}

fn main() {
    let args = Args::parse();
    export::run(&args.project);
}
`,
  'cli/src/export.rs': `use serde::Serialize;

#[derive(Serialize)]
pub struct ExportOptions {
    pub include_comments: bool,
}

/// Writes a project with its tasks as JSON to stdout.
pub fn export_project_json(project: &str, options: &ExportOptions) -> String {
    serde_json::to_string(&(project, options.include_comments)).unwrap()
}

pub fn run(project: &str) {
    println!("{}", export_project_json(project, &ExportOptions { include_comments: true }));
}
`,
  'tests/auth/session.test.ts': `import { describe, expect, it } from 'vitest';
import { isSessionExpired, refreshAccessToken, SESSION_TTL_MS } from '../../src/auth/session';

describe('session', () => {
  it('refreshes the access token before it expires so users are not logged out', async () => {
    const session = { userId: 'u', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 };
    const next = await refreshAccessToken(session);
    expect(next.expiresAt).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 1000);
    expect(isSessionExpired(next)).toBe(false);
  });
});
`,
  'tests/billing/invoice.test.ts': `import { describe, expect, it } from 'vitest';
import { computeTax } from '../../src/billing/invoice';

describe('invoice VAT', () => {
  it('charges VAT on the net amount', () => {
    expect(computeTax([{ description: 'Seat', quantity: 2, unitPriceCents: 1000 }], 0.2)).toBe(400);
  });
});
`,
  'package.json': `{ "name": "acme-tasks", "private": true, "scripts": { "dev": "tsx src/api/server.ts" } }
`,
  'pnpm-lock.yaml': `lockfileVersion: '9.0'
`,
  '.env.example': `STRIPE_SECRET_KEY=sk_test_example_do_not_index
`,
};

export interface AblationQuery {
  title: string;
  description: string;
  expected: readonly string[];
}

export const ABLATION_QUERIES: readonly AblationQuery[] = [
  { title: 'Users get logged out after an hour', description: 'The access token is not renewed before it expires, so people have to sign in again.', expected: ['src/auth/session.ts'] },
  { title: 'Invoice PDF shows the wrong VAT amount', description: 'Tax is computed on the gross total instead of each line.', expected: ['src/billing/invoice.ts'] },
  { title: 'Failed card payments do not downgrade the plan', description: 'When Stripe reports invoice.payment_failed the subscription should become past due.', expected: ['src/billing/stripe-webhook.ts'] },
  { title: 'Daily summary email lists tasks under the wrong project', description: 'Two projects with the same name are merged in the summary.', expected: ['src/notifications/digest.ts'] },
  { title: 'Dragging a card to another column loses its position', description: 'The card always lands at the bottom instead of where it was dropped.', expected: ['src/tasks/board.ts'] },
  { title: 'CSV import breaks on semicolon separated files', description: 'European spreadsheets export with ; as the separator.', expected: ['src/tasks/import-csv.ts'] },
  { title: 'Weekly repeating tasks skip a week', description: 'Around daylight saving changes the next due date jumps two weeks.', expected: ['src/tasks/recurrence.ts'] },
  { title: 'Bulk updates are refused with too many requests', description: 'Updating 100 tasks at once returns 429 although the user is well below the limit.', expected: ['src/api/middleware/rate-limit.ts'] },
  { title: 'Profile picture upload fails for large images', description: 'Photos from phones are rejected as too large.', expected: ['src/storage/s3-upload.ts', 'web/components/AvatarUploader.tsx'] },
  { title: 'Google Calendar events are created twice', description: 'When an event changes its ETag the sync inserts a second copy.', expected: ['worker/sync.go'] },
  { title: 'Priority suggestions are always medium', description: 'The model that guesses an issue priority from its text returns medium for everything.', expected: ['ml/classify_priority.py'] },
  { title: 'Duplicate detection misses near-identical titles', description: 'Titles that differ by one word are not reported as duplicates.', expected: ['ml/dedupe.py'] },
  { title: 'Export a project as JSON from the command line', description: 'Comments should be optional in the exported file.', expected: ['cli/src/export.rs'] },
  { title: 'The date picker cannot be used with the keyboard', description: 'Arrow keys should move between days in the calendar.', expected: ['web/components/DatePicker.tsx'] },
  { title: 'Let people turn off push notifications per project', description: 'Settings only has a global switch for mobile notifications.', expected: ['web/pages/settings/notifications.tsx', 'src/notifications/push.ts'] },
  { title: 'Retry webhook deliveries with exponential backoff', description: 'A single failed delivery is never retried.', expected: ['src/util/retry.ts'] },
  { title: 'Sign in with GitHub fails with a state mismatch', description: 'The OAuth callback rejects the state after a server restart.', expected: ['src/auth/oauth-github.ts'] },
  { title: 'Session refresh: change SESSION_TTL_MS to two hours', description: 'See src/auth/session.ts.', expected: ['src/auth/session.ts'] },
];
