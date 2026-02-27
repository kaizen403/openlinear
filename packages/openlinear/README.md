# OpenLinear

OpenLinear launcher, installer, and validation utilities.

## Installation

```bash
npm install -g openlinear
```

## Usage

### CLI Launcher

```bash
openlinear
```

### Programmatic API

```typescript
import { 
  validateExecutionMetadataSync,
  safeValidateExecutionMetadataSync,
  FORBIDDEN_SYNC_FIELDS,
  isLocalExecutionEnabled,
  parseFeatureFlags 
} from 'openlinear';

// Validate execution metadata
const result = safeValidateExecutionMetadataSync({
  taskId: 'tsk_123',
  runId: 'run_456',
  status: 'completed',
  durationMs: 45000
});

if (result.success) {
  console.log('Valid metadata:', result.data);
} else {
  console.error('Validation failed:', result.error);
}

// Check feature flags
const flags = parseFeatureFlags();
const localEnabled = isLocalExecutionEnabled('user-123', flags);
```

## Exports

### Main (`openlinear`)

- `validateExecutionMetadataSync` - Validate metadata payload
- `safeValidateExecutionMetadataSync` - Safe validation that returns result
- `FORBIDDEN_SYNC_FIELDS` - List of fields that cannot be synced
- `isForbiddenField` - Check if a field is forbidden
- `sanitizePayload` - Remove forbidden fields from payload
- `parseFeatureFlags` - Parse feature flags from environment
- `isLocalExecutionEnabled` - Check if local execution is enabled
- `getMigrationPhase` - Get current migration phase

### Types (`openlinear/types`)

- `ExecutionMetadataSync` - Type for execution metadata
- `ExecutionMetadataSyncSchema` - Zod schema for validation
- `ExecutionStatus` - Execution status enum
- `ErrorCategory` - Error category enum

### Validation (`openlinear/validation`)

- `checkExecutionMetadataSync` - Check if payload is valid
- `isForbiddenField` - Check if field is forbidden
- `sanitizePayload` - Sanitize payload by removing forbidden fields
- `FORBIDDEN_SYNC_FIELDS` - Array of forbidden field names

### Config (`openlinear/config`)

- `parseFeatureFlags` - Parse feature flags
- `getFeatureFlags` - Get feature flags from environment
- `isLocalExecutionEnabled` - Check local execution for user
- `isServerExecutionEnabled` - Check server execution
- `validateFlagConfiguration` - Validate flag config
- `getMigrationPhase` - Get migration phase

## Security

This package enforces the trust-boundary policy:

- **Cloud-Allowed**: taskId, status, durationMs, progress, branch, prUrl, etc.
- **Local-Only**: accessToken, apiKey, repoPath, etc.
- **Forbidden**: prompt, logs, toolLogs, executionLogs, etc.

See [docs/security/trust-boundary.md](docs/security/trust-boundary.md) for full policy.

## License

MIT
