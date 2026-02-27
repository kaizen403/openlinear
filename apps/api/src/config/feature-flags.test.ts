import { describe, it, expect } from 'vitest';
import {
  parseFeatureFlags,
  isLocalExecutionEnabled,
  isServerExecutionEnabled,
  validateFlagConfiguration,
  getMigrationPhase,
  type FeatureFlags,
} from './feature-flags';

describe('Feature Flags', () => {
  describe('parseFeatureFlags', () => {
    it('should parse default values', () => {
      const flags = parseFeatureFlags({});
      
      expect(flags.LOCAL_EXECUTION_ENABLED).toBe(false);
      expect(flags.SERVER_EXECUTION_ENABLED).toBe(true);
      expect(flags.CANARY_PERCENTAGE).toBe(0);
      expect(flags.FORCE_LOCAL_EXECUTION).toBe(false);
      expect(flags.KILL_SWITCH_LOCAL_EXECUTION).toBe(false);
    });

    it('should parse custom values', () => {
      const env = {
        LOCAL_EXECUTION_ENABLED: 'true',
        SERVER_EXECUTION_ENABLED: 'false',
        CANARY_PERCENTAGE: '25',
        FORCE_LOCAL_EXECUTION: 'true',
        KILL_SWITCH_LOCAL_EXECUTION: 'false',
      };
      
      const flags = parseFeatureFlags(env);
      
      expect(flags.LOCAL_EXECUTION_ENABLED).toBe(true);
      expect(flags.SERVER_EXECUTION_ENABLED).toBe(false);
      expect(flags.CANARY_PERCENTAGE).toBe(25);
      expect(flags.FORCE_LOCAL_EXECUTION).toBe(true);
      expect(flags.KILL_SWITCH_LOCAL_EXECUTION).toBe(false);
    });

    it('should reject invalid canary percentage', () => {
      const env = { CANARY_PERCENTAGE: '150' };
      
      expect(() => parseFeatureFlags(env)).toThrow();
    });

    it('should reject negative canary percentage', () => {
      const env = { CANARY_PERCENTAGE: '-10' };
      
      expect(() => parseFeatureFlags(env)).toThrow();
    });
  });

  describe('isLocalExecutionEnabled', () => {
    it('should return false by default', () => {
      const flags = parseFeatureFlags({});
      
      expect(isLocalExecutionEnabled('user-1', flags)).toBe(false);
    });

    it('should return true when local execution enabled and 100% canary', () => {
      const flags = parseFeatureFlags({
        LOCAL_EXECUTION_ENABLED: 'true',
        CANARY_PERCENTAGE: '100',
      });
      
      expect(isLocalExecutionEnabled('user-1', flags)).toBe(true);
    });

    it('should respect canary percentage', () => {
      const flags = parseFeatureFlags({
        LOCAL_EXECUTION_ENABLED: 'true',
        CANARY_PERCENTAGE: '50',
      });
      
      const results = Array.from({ length: 100 }, (_, i) =>
        isLocalExecutionEnabled(`user-${i}`, flags)
      );
      
      const enabledCount = results.filter(Boolean).length;
      expect(enabledCount).toBeGreaterThan(30);
      expect(enabledCount).toBeLessThan(70);
    });

    it('should return false when kill switch is enabled', () => {
      const flags = parseFeatureFlags({
        LOCAL_EXECUTION_ENABLED: 'true',
        CANARY_PERCENTAGE: '100',
        KILL_SWITCH_LOCAL_EXECUTION: 'true',
      });
      
      expect(isLocalExecutionEnabled('user-1', flags)).toBe(false);
    });

    it('should return true when force flag is enabled', () => {
      const flags = parseFeatureFlags({
        LOCAL_EXECUTION_ENABLED: 'false',
        FORCE_LOCAL_EXECUTION: 'true',
      });
      
      expect(isLocalExecutionEnabled('user-1', flags)).toBe(true);
    });

    it('should prioritize kill switch over force', () => {
      const flags = parseFeatureFlags({
        FORCE_LOCAL_EXECUTION: 'true',
        KILL_SWITCH_LOCAL_EXECUTION: 'true',
      });
      
      expect(isLocalExecutionEnabled('user-1', flags)).toBe(false);
    });

    it('should be deterministic for same user', () => {
      const flags = parseFeatureFlags({
        LOCAL_EXECUTION_ENABLED: 'true',
        CANARY_PERCENTAGE: '50',
      });
      
      const result1 = isLocalExecutionEnabled('user-abc', flags);
      const result2 = isLocalExecutionEnabled('user-abc', flags);
      const result3 = isLocalExecutionEnabled('user-abc', flags);
      
      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
    });
  });

  describe('isServerExecutionEnabled', () => {
    it('should return true by default', () => {
      const flags = parseFeatureFlags({});
      
      expect(isServerExecutionEnabled(flags)).toBe(true);
    });

    it('should return false when disabled', () => {
      const flags = parseFeatureFlags({
        SERVER_EXECUTION_ENABLED: 'false',
      });
      
      expect(isServerExecutionEnabled(flags)).toBe(false);
    });
  });

  describe('validateFlagConfiguration', () => {
    it('should pass for valid configuration', () => {
      const flags = parseFeatureFlags({});
      const result = validateFlagConfiguration(flags);
      
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail when both force and kill switch enabled', () => {
      const flags = parseFeatureFlags({
        FORCE_LOCAL_EXECUTION: 'true',
        KILL_SWITCH_LOCAL_EXECUTION: 'true',
      });
      const result = validateFlagConfiguration(flags);
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'Cannot enable both FORCE_LOCAL_EXECUTION and KILL_SWITCH_LOCAL_EXECUTION'
      );
    });

    it('should fail when neither execution mode enabled', () => {
      const flags = parseFeatureFlags({
        LOCAL_EXECUTION_ENABLED: 'false',
        SERVER_EXECUTION_ENABLED: 'false',
      });
      const result = validateFlagConfiguration(flags);
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('At least one execution mode must be enabled');
    });
  });

  describe('getMigrationPhase', () => {
    it('should return rollback when kill switch enabled', () => {
      const flags = parseFeatureFlags({
        KILL_SWITCH_LOCAL_EXECUTION: 'true',
      });
      
      expect(getMigrationPhase(flags)).toBe('rollback');
    });

    it('should return cutover when server disabled', () => {
      const flags = parseFeatureFlags({
        SERVER_EXECUTION_ENABLED: 'false',
      });
      
      expect(getMigrationPhase(flags)).toBe('cutover');
    });

    it('should return canary when local enabled and canary > 0', () => {
      const flags = parseFeatureFlags({
        LOCAL_EXECUTION_ENABLED: 'true',
        CANARY_PERCENTAGE: '10',
      });
      
      expect(getMigrationPhase(flags)).toBe('canary');
    });

    it('should return shadow when local enabled and canary is 0', () => {
      const flags = parseFeatureFlags({
        LOCAL_EXECUTION_ENABLED: 'true',
        CANARY_PERCENTAGE: '0',
      });
      
      expect(getMigrationPhase(flags)).toBe('shadow');
    });

    it('should return unknown for default state', () => {
      const flags = parseFeatureFlags({});
      
      expect(getMigrationPhase(flags)).toBe('unknown');
    });
  });
});
