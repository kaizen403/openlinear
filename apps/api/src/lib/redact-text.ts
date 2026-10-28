/**
 * FE-16: redact credentials that may appear in free text (task outcomes,
 * comments, agent error messages) before it leaves the system in an export.
 * Conservative token shapes plus `name=value` / `Authorization:` forms; the
 * replacement keeps the label so the text stays readable.
 */

const CENSOR = '[redacted]';

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // PEM private keys (whole block).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, CENSOR],
  // GitHub tokens (classic and fine-grained).
  [/\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g, CENSOR],
  [/\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, CENSOR],
  // OpenLinear personal access tokens and execution capabilities.
  [/\bol_pat_[0-9a-f]{32}\b/g, CENSOR],
  [/\bolx_[A-Za-z0-9_-]{16,255}\b/g, CENSOR],
  // Provider API keys (OpenAI / Anthropic / generic sk-), Google, Slack, AWS access key ids.
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,255}\b/g, CENSOR],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, CENSOR],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,255}\b/g, CENSOR],
  [/\bAKIA[0-9A-Z]{16}\b/g, CENSOR],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, CENSOR],
  // Authorization headers.
  [/\b(Authorization\s*:\s*)(?:Bearer|Basic|token)\s+[^\s"']+/gi, `$1${CENSOR}`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, `$1${CENSOR}`],
  // name=value / name: value for secret-looking names.
  [/\b((?:[A-Za-z0-9_]*_)?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, `$1${CENSOR}`],
  // Credentials embedded in URLs.
  // (The scheme is bounded: an unbounded one backtracks quadratically on text like `a.a.a.…`.)
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${CENSOR}@`],
];

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function redactNullable(text: string | null | undefined): string | null {
  return typeof text === 'string' ? redactText(text) : null;
}
