import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  ExecutionMetadataSyncSchema,
  validateExecutionMetadataSync,
  safeValidateExecutionMetadataSync,
  checkExecutionMetadataSync,
  FORBIDDEN_SYNC_FIELDS,
  ExecutionStatus,
  ErrorCategory,
} from './execution-metadata';

describe('ExecutionMetadataSyncSchema', () => {
  describe('valid payloads', () => {
    it('should accept minimal valid payload', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'pending',
      };
      
      const result = safeValidateExecutionMetadataSync(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.taskId).toBe('tsk_123');
        expect(result.data.status).toBe('pending');
      }
    });

    it('should accept full valid payload', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'completed',
        startedAt: '2026-02-27T10:00:00Z',
        completedAt: '2026-02-27T10:01:30Z',
        durationMs: 90000,
        progress: 100,
        branch: 'feature/task-123',
        commitSha: 'abc123',
        prUrl: 'https://github.com/owner/repo/pull/42',
        prNumber: 42,
        outcome: 'Successfully implemented feature',
        errorCategory: undefined,
        filesChanged: 3,
        toolsExecuted: 12,
      };
      
      const result = safeValidateExecutionMetadataSync(payload);
      expect(result.success).toBe(true);
    });

    it('should accept all valid status values', () => {
      const statuses = ['pending', 'running', 'completed', 'failed', 'cancelled'];
      
      for (const status of statuses) {
        const payload = { taskId: 'tsk_123', runId: 'run_456', status };
        const result = safeValidateExecutionMetadataSync(payload);
        expect(result.success).toBe(true);
      }
    });

    it('should accept all valid error categories', () => {
      const categories = ['AUTH', 'RATE_LIMIT', 'MERGE_CONFLICT', 'TIMEOUT', 'UNKNOWN'];
      
      for (const errorCategory of categories) {
        const payload = { 
          taskId: 'tsk_123', 
          runId: 'run_456', 
          status: 'failed',
          errorCategory 
        };
        const result = safeValidateExecutionMetadataSync(payload);
        expect(result.success).toBe(true);
      }
    });
  });

  describe('forbidden field rejection', () => {
    it('should reject payload with prompt field', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'completed',
        prompt: 'Fix the bug in src/auth.ts',
      };
      
      const result = safeValidateExecutionMetadataSync(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Unrecognized');
      }
    });

    it('should reject payload with toolLogs field', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'completed',
        toolLogs: [{ command: 'cat src/auth.ts', output: 'import { jwt }' }],
      };
      
      const result = safeValidateExecutionMetadataSync(payload);
      expect(result.success).toBe(false);
    });

    it('should reject payload with repoPath field', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'completed',
        repoPath: '/Users/dev/projects/myrepo',
      };
      
      const result = safeValidateExecutionMetadataSync(payload);
      expect(result.success).toBe(false);
    });

    it('should reject payload with accessToken field', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'completed',
        accessToken: 'gho_abc123secret',
      };
      
      const result = safeValidateExecutionMetadataSync(payload);
      expect(result.success).toBe(false);
    });

    it('should reject all known forbidden fields', () => {
      for (const field of FORBIDDEN_SYNC_FIELDS) {
        const payload = {
          taskId: 'tsk_123',
          runId: 'run_456',
          status: 'completed',
          [field]: 'some-value',
        };
        
        const result = safeValidateExecutionMetadataSync(payload);
        expect(result.success).toBe(false);
      }
    });

    it('should provide clear error for unknown fields', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'completed',
        prompt: 'secret prompt content',
      };
      
      const check = checkExecutionMetadataSync(payload);
      expect(check.valid).toBe(false);
      expect(check.issues).toBeDefined();
      expect(check.issues!.some(i => i.includes('prompt'))).toBe(true);
    });
  });

  describe('type validation', () => {
    it('should reject invalid status', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'invalid-status',
      };
      
      const result = safeValidateExecutionMetadataSync(payload);
      expect(result.success).toBe(false);
    });

    it('should reject invalid errorCategory', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'failed',
        errorCategory: 'INVALID_CATEGORY',
      };
      
      const result = safeValidateExecutionMetadataSync(payload);
      expect(result.success).toBe(false);
    });

    it('should reject negative durationMs', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'completed',
        durationMs: -100,
      };
      
      const result = safeValidateExecutionMetadataSync(payload);
      expect(result.success).toBe(false);
    });

    it('should reject progress over 100', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'running',
        progress: 150,
      };
      
      const result = safeValidateExecutionMetadataSync(payload);
      expect(result.success).toBe(false);
    });

    it('should reject invalid datetime', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'completed',
        startedAt: 'not-a-datetime',
      };
      
      const result = safeValidateExecutionMetadataSync(payload);
      expect(result.success).toBe(false);
    });
  });

  describe('throwing validator', () => {
    it('should throw on invalid payload', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'completed',
        prompt: 'secret',
      };
      
      expect(() => validateExecutionMetadataSync(payload)).toThrow(z.ZodError);
    });

    it('should return valid data on success', () => {
      const payload = {
        taskId: 'tsk_123',
        runId: 'run_456',
        status: 'completed',
        durationMs: 5000,
      };
      
      const result = validateExecutionMetadataSync(payload);
      expect(result.taskId).toBe('tsk_123');
      expect(result.durationMs).toBe(5000);
    });
  });

  describe('ExecutionStatus enum', () => {
    it('should contain all expected values', () => {
      const values = ExecutionStatus._def.values;
      expect(values).toContain('pending');
      expect(values).toContain('running');
      expect(values).toContain('completed');
      expect(values).toContain('failed');
      expect(values).toContain('cancelled');
    });
  });

  describe('ErrorCategory enum', () => {
    it('should contain all expected values', () => {
      const values = ErrorCategory._def.values;
      expect(values).toContain('AUTH');
      expect(values).toContain('RATE_LIMIT');
      expect(values).toContain('MERGE_CONFLICT');
      expect(values).toContain('TIMEOUT');
      expect(values).toContain('UNKNOWN');
    });
  });
});
