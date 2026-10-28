/**
 * W16b: the lexical vocabulary of the repository context index. One
 * tokenizer for repository text and task text, so both sides of a match are
 * normalised the same way:
 *
 * - identifiers are split on case changes, `_`, `-`, digits boundaries and
 *   punctuation (`resolveTaskWorkspace` → resolve, task, workspace), and an
 *   identifier of several parts also yields its joined lowercase form
 *   (`resolvetaskworkspace`) so an exact mention of a symbol scores high;
 * - parts are lowercased, 2–32 characters, never stop words, and pass a tiny
 *   deterministic suffix stemmer (plurals, -ing/-ed, trailing e) that maps
 *   "caches", "cached", "caching" and "cache" to one term.
 *
 * Pure: no I/O.
 */

const MIN_TERM = 2;
const MAX_TERM = 32;
const MAX_JOINED = 48;

/** English function words and language keywords: never terms on either side. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'each', 'either',
  'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'may',
  'me', 'might', 'more', 'most', 'my', 'no', 'not', 'of', 'on', 'once', 'one', 'only', 'or', 'other', 'our', 'out', 'over', 'own',
  'same', 'she', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'too', 'under', 'until', 'up', 'us', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'also', 'any', 'all', 'both', 'about', 'after', 'again', 'against',
  'before', 'being', 'below', 'between', 'during', 'few', 'further', 'here', 'nor', 'off', 'above', 'because', 'should', 'must',
  // keywords shared by the indexed languages
  'abstract', 'async', 'await', 'break', 'case', 'catch', 'const', 'continue', 'def', 'default', 'del', 'elif', 'else',
  'end', 'enum', 'export', 'extends', 'false', 'final', 'finally', 'fn', 'func', 'function', 'go', 'impl', 'implements', 'import',
  'let', 'mut', 'nil', 'none', 'null', 'pass', 'pub', 'raise', 'readonly', 'return', 'self', 'static', 'super', 'switch',
  'throw', 'throws', 'true', 'try', 'typeof', 'undefined', 'unless', 'use', 'var', 'void', 'yield', 'elsif', 'begin', 'rescue',
  'require', 'instanceof', 'keyof', 'satisfies', 'declare', 'namespace', 'public', 'private', 'protected', 'internal', 'crate',
  'mod', 'struct', 'trait', 'loop', 'match', 'ref', 'dyn', 'new', 'http', 'https', 'www', 'com', 'org',
  // path noise
  'src', 'lib', 'test', 'tests', 'spec', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'rb', 'md',
]);

/**
 * Words that describe the kind of work rather than the code ("fix the bug in
 * …", "please add support for …"). Removed from task text only: in the
 * repository they can still be meaningful (a `fix` module, a `support` dir).
 */
const QUERY_STOP_WORDS = new Set([
  'add', 'added', 'adding', 'allow', 'bug', 'bugs', 'change', 'changes', 'currently', 'doesn', 'don', 'ensure', 'feature',
  'fix', 'fixed', 'fixes', 'get', 'got', 'implement', 'improve', 'instead', 'issue', 'issues', 'like', 'make',
  'need', 'needs', 'please', 'problem', 'properly', 'really', 'remove', 'right', 'see', 'something', 'still', 'support', 'sure',
  'task', 'tasks', 'thing', 'things', 'try', 'update', 'updated', 'want', 'way', 'work', 'works', 'working', 'wrong', 'now',
  'able', 'everything', 'nothing', 'look', 'looks', 'old',
]);

const DOUBLED_KEEP = new Set(['l', 's', 'z', 'f']);

/** Deterministic light stemmer (see the module comment). */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) {
    w = `${w.slice(0, -3)}y`;
  } else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    w = w.slice(0, -1);
  }
  if (w.endsWith('ing') && w.length - 3 >= 3) {
    w = w.slice(0, -3);
    w = undouble(w);
  } else if (w.endsWith('ed') && w.length - 2 >= 3) {
    w = w.slice(0, -2);
    w = undouble(w);
  }
  if (w.endsWith('e') && w.length > 3) w = w.slice(0, -1);
  return w;
}

function undouble(w: string): string {
  const last = w[w.length - 1];
  if (w.length >= 3 && last === w[w.length - 2] && !DOUBLED_KEEP.has(last) && !/[aeiou]/.test(last)) return w.slice(0, -1);
  return w;
}

/** The lowercase parts of one identifier-like run, before stemming. */
export function identifierParts(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

function acceptTerm(part: string): string | null {
  if (part.length < MIN_TERM || part.length > MAX_TERM) return null;
  if (/^\d+$/.test(part)) return null;
  if (STOP_WORDS.has(part)) return null;
  return stem(part);
}

// Bounded: an unbounded middle backtracks quadratically on long runs that
// never end in a letter or digit (e.g. 100k underscores froze the sidecar for
// minutes). Longer identifiers simply split into 64-character runs.
const RUN = /[A-Za-z_$][A-Za-z0-9_$-]{0,62}[A-Za-z0-9]|[A-Za-z]/g;

interface TokenizeOptions {
  /** Add the joined form of multi-part identifiers (default true). */
  joined?: boolean;
  /** Task text: also drop the work-description words. */
  query?: boolean;
}

function visitTerms(text: string, options: TokenizeOptions, visit: (term: string, surface: string) => void): void {
  const joined = options.joined !== false;
  for (const match of text.matchAll(RUN)) {
    const raw = match[0];
    const parts = identifierParts(raw);
    let kept = 0;
    for (const part of parts) {
      if (options.query && QUERY_STOP_WORDS.has(part)) continue;
      const term = acceptTerm(part);
      if (term) {
        visit(term, part);
        kept += 1;
      }
    }
    if (joined && parts.length > 1 && kept > 0) {
      const whole = parts.join('');
      if (whole.length <= MAX_JOINED) visit(whole, raw);
    }
  }
}

/**
 * Terms of a piece of text, in order of appearance (with repeats, so callers
 * can count term frequency).
 */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const out: string[] = [];
  visitTerms(text, options, (term) => out.push(term));
  return out;
}

/** Task-text terms with the word each came from (first occurrence), for showing matches to people. */
export function queryTerms(text: string): Array<{ term: string; surface: string }> {
  const out: Array<{ term: string; surface: string }> = [];
  visitTerms(text, { query: true }, (term, surface) => out.push({ term, surface }));
  return out;
}

/** Path tokens: directory segments and the file name (without its extension) as separate fields. */
export function pathTerms(path: string): { name: string[]; dir: string[] } {
  const slash = path.lastIndexOf('/');
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dir = slash === -1 ? '' : path.slice(0, slash);
  const dot = base.indexOf('.', 1);
  const stemName = dot === -1 ? base : base.slice(0, dot);
  return { name: tokenize(stemName), dir: tokenize(dir.replace(/\//g, ' ')) };
}

export function countTerms(terms: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

/** Path-like mentions in task text (`src/app.ts`, `routes/runners.ts`, `README.md`), lowercased. */
export function pathMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\.[A-Za-z][A-Za-z0-9]{0,7}\b/g)) {
    const mention = match[0].replace(/^\.\//, '').toLowerCase();
    if (mention.length >= 4 && mention.length <= 300 && !/^\d/.test(mention) && !/^(?:e\.g|i\.e|etc)\./.test(mention)) found.add(mention);
  }
  return [...found].sort();
}
