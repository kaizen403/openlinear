# Learnings

## Task 1: Secret Taxonomy and Trust-Boundary Policy
- **Cloud-Allowed Metadata**: `taskId`, `projectId`, `sessionId`, `branchName`, `status`, `filesChanged`, `toolsExecuted`, `startedAt`, `executionElapsedMs`, `executionProgress`, `prUrl`, `outcome`.
- **Local-Only / Forbidden**: `repoPath`, `accessToken`, `jwt`, `passwordHash`, `prompt`, `logs`, `toolLogs`, `executionLogs`, `client`, `timeoutId`.
- **Enforcement Strategy**: Use explicit allowlists (Zod schemas) for sync payloads rather than blocklists.

## Task 1: Trust Boundary Policy Implementation
- Created `docs/security/trust-boundary.md` with strict taxonomy.
- Classified fields into `Cloud-Allowed`, `Local-Only`, and `Forbidden to Sync`.
- Explicitly marked `prompt`, `toolLogs`, raw terminal output, and absolute local paths as forbidden.
- Recommended allowlist validation (Zod schemas) over blocklists for enforcement.
