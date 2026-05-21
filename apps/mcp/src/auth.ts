import type { Request } from "express";

export function extractPat(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!/^ol_pat_[a-f0-9]{32}$/.test(token)) return null;
  return token;
}
