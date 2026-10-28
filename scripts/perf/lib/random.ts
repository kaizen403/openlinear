/** Deterministic generators for the perf fixture. Same seed => same rows. */
import { createHash } from 'node:crypto';

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** mulberry32: uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[Math.floor(this.next() * items.length)];
  }

  /** Pick by weight; `weights` need not sum to 1. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1][0];
  }

  /** `count` distinct items (or all of them when fewer exist). */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    while (out.length < count && pool.length > 0) {
      const index = Math.floor(this.next() * pool.length);
      out.push(pool[index]);
      pool[index] = pool[pool.length - 1];
      pool.pop();
    }
    return out;
  }
}

/** RFC 4122-shaped (version 5 nibble, variant 10xx) UUID derived from a name. */
export function stableUuid(namespace: string, ...parts: Array<string | number>): string {
  const hex = createHash('sha1').update(`${namespace}:${parts.join(':')}`).digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Zipf-like weights: the first items are much larger than the tail. */
export function zipfWeights(count: number, exponent: number): number[] {
  const weights = Array.from({ length: count }, (_, i) => 1 / (i + 1) ** exponent);
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

/** Split `total` into integer parts proportional to `weights` (largest remainder). */
export function apportion(total: number, weights: readonly number[]): number[] {
  const raw = weights.map((w) => w * total);
  const floors = raw.map(Math.floor);
  let remaining = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const { index } of order) {
    if (remaining <= 0) break;
    floors[index] += 1;
    remaining -= 1;
  }
  return floors;
}

const WORDS = (
  'account adapter agent alert analytics api archive assignee audit auth backend backlog badge banner batch billing ' +
  'board branch browser buffer build cache calendar callback cancel canvas card cart chart chat checkout cleanup cli ' +
  'client clone cluster column command comment commit config connection console container context cookie copy cors ' +
  'coverage cron css csv cursor dashboard data database deadlock debounce default delete deploy desktop diff digest ' +
  'docs domain download draft drag dropdown editor email embed endpoint engine error event export feature feed field ' +
  'filter flag flaky font footer form gateway git github graph grid group handler header health hook icon import ' +
  'inbox index input install integration invite issue job json kanban key label latency layout lazy lease limit ' +
  'link lint list load locale lock log login logout markdown member memory menu merge message metrics migration ' +
  'mobile modal model monitor navigation network notification oauth offline onboarding order pagination panel ' +
  'parser password patch payload payment pdf permission pipeline plan plugin policy popover preview pricing profile ' +
  'project prompt proxy pull push query queue quota rate react redirect refactor refresh regression release render ' +
  'replay report repository request reset resize response retry review role route runner sandbox scheduler schema ' +
  'scope screen script scroll search secret select server session settings setup sidebar signup sitemap snapshot ' +
  'socket sort spinner sql sse stack staging state status storage stream style subscription summary sync table tag ' +
  'task team telemetry template tenant test theme thread throttle timeline timeout toast token tooltip trace ' +
  'transaction trigger typo upload usage user validation version video view webhook websocket widget workflow ' +
  'workspace worktree'
).split(' ');

const VERBS = [
  'Fix', 'Add', 'Improve', 'Refactor', 'Remove', 'Investigate', 'Document', 'Support', 'Optimize', 'Migrate',
  'Handle', 'Validate', 'Cache', 'Paginate', 'Split', 'Harden', 'Rename', 'Expose', 'Retry', 'Throttle',
];

/** Rare token planted in a known number of titles, for selective search. */
export const RARE_SEARCH_TERM = 'zephyrine';
/** Common token: appears in a few percent of titles and descriptions. */
export const COMMON_SEARCH_TERM = 'latency';

export function sentence(rng: Rng, minWords: number, maxWords: number): string {
  const count = rng.int(minWords, maxWords);
  const words: string[] = [];
  for (let i = 0; i < count; i += 1) words.push(rng.pick(WORDS));
  return words.join(' ');
}

export function taskTitle(rng: Rng): string {
  return `${rng.pick(VERBS)} ${sentence(rng, 3, 8)}`;
}

export function paragraph(rng: Rng, minChars: number, maxChars: number): string {
  const target = rng.int(minChars, maxChars);
  const parts: string[] = [];
  let length = 0;
  while (length < target) {
    const s = `${sentence(rng, 6, 16)}.`;
    parts.push(s.charAt(0).toUpperCase() + s.slice(1));
    length += s.length + 1;
  }
  return parts.join(' ').slice(0, target);
}
