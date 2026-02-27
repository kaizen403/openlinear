# Secret Taxonomy and Trust-Boundary Policy

This document defines the trust boundary between the local desktop environment and the cloud API. It establishes a strict taxonomy for data classification to ensure that sensitive local execution context, secrets, and raw logs are never synchronized to the cloud.

## Cloud-Allowed

These fields are permitted to cross the trust boundary and be synchronized to the cloud. They consist primarily of execution metadata and non-sensitive identifiers.

*   **Execution Metadata**: `taskId`, `projectId`, `sessionId`, `branchName`, `status`, `startedAt`, `executionElapsedMs`, `executionProgress`, `prUrl`, `outcome`.
*   **Non-Sensitive Context**: `filesChanged` (relative paths only), `toolsExecuted` (tool names only, no arguments or outputs).

## Local-Only

These fields represent the local execution context and authentication state. They must remain exclusively on the local machine and are never transmitted to the cloud.

*   **Auth**: `accessToken`, `jwt`, `passwordHash`, `githubToken`, `opencodeApiKey`.
*   **Local Execution Context**: `repoPath` (absolute local paths), `client`, `timeoutId`, `dockerContainerId`.

## Forbidden to Sync

These fields contain potentially sensitive information, raw outputs, or user-specific data that must be explicitly blocked from cloud synchronization.

*   **Logs**: `logs`, `toolLogs`, `executionLogs`, raw terminal output, stdout/stderr streams.
*   **User Input/Prompts**: `prompt`, `systemPrompt`, `customInstructions`.
*   **Paths**: Absolute local paths (e.g., `/Users/name/project/...`).

## Enforcement

To guarantee that forbidden fields never cross the trust boundary, the following enforcement mechanisms must be implemented:

1.  **Allowlist Validation**: All sync payloads must be validated against a strict allowlist (e.g., using Zod schemas). Any field not explicitly defined in the allowlist must be stripped before transmission.
2.  **No Blocklists**: Do not rely on blocklists (e.g., `omit(['prompt', 'logs'])`), as new sensitive fields may be added in the future and accidentally leaked.
3.  **Path Sanitization**: Any file paths included in the `filesChanged` array must be sanitized to ensure they are strictly relative to the repository root.
4.  **Pre-Sync Hook**: Implement a pre-sync middleware that enforces the Zod schema and logs a local warning if forbidden fields are detected and stripped.

### Allowed Payload Example

```json
{
  "taskId": "tsk_12345",
  "projectId": "prj_67890",
  "status": "completed",
  "branchName": "feature/add-auth",
  "executionElapsedMs": 45000,
  "filesChanged": ["src/auth.ts", "package.json"],
  "toolsExecuted": ["bash", "edit"]
}
```

### Rejected Payload Example

```json
{
  "taskId": "tsk_12345",
  "status": "completed",
  "prompt": "Fix the authentication bug in src/auth.ts",
  "repoPath": "/Users/dev/projects/openlinear",
  "accessToken": "gho_abc123def456",
  "toolLogs": ["[bash] npm install -> success", "[edit] src/auth.ts -> success"]
}
```
