/**
 * Prisma passes `contains`/`startsWith` values to PostgreSQL `(I)LIKE`
 * without escaping, so a user's `%` or `_` acted as a wildcard (`q=1_0`
 * matched "100"). Escape them (and the escape character itself) so search
 * text is matched literally. PostgreSQL's default LIKE escape is `\`.
 */
export function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
