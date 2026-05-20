import crypto from 'node:crypto';

export function makeEtag(parts: Array<string | number | Date | null | undefined>): string {
  const input = parts
    .map((part) => (part instanceof Date ? part.toISOString() : String(part ?? '')))
    .join('|');
  return `"${crypto.createHash('sha1').update(input).digest('base64url')}"`;
}
