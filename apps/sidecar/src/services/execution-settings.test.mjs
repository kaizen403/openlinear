import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('@openlinear/db', () => ({
  prisma: {
    settings: {
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
    },
  },
}));

const { getExecutionSettings } = await import('./execution-settings');

describe('execution settings', () => {
  beforeEach(() => {
    mocks.findUnique.mockReset();
    mocks.findFirst.mockReset();
  });

  it('uses user-scoped settings first', async () => {
    mocks.findUnique.mockResolvedValue({
      parallelLimit: 5,
      maxBatchSize: 7,
      queueAutoApprove: true,
      stopOnFailure: true,
      conflictBehavior: 'fail',
    });

    await expect(getExecutionSettings('user-1')).resolves.toEqual({
      parallelLimit: 5,
      maxBatchSize: 7,
      queueAutoApprove: true,
      stopOnFailure: true,
      conflictBehavior: 'fail',
    });
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to legacy unscoped settings', async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.findFirst.mockResolvedValue({
      parallelLimit: 2,
      maxBatchSize: 4,
      queueAutoApprove: false,
      stopOnFailure: true,
      conflictBehavior: 'skip',
    });

    await expect(getExecutionSettings('user-1')).resolves.toMatchObject({
      parallelLimit: 2,
      maxBatchSize: 4,
      stopOnFailure: true,
      conflictBehavior: 'skip',
    });
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { userId: null } });
  });

  it('uses defaults when no settings rows exist', async () => {
    mocks.findFirst.mockResolvedValue(null);

    await expect(getExecutionSettings(null)).resolves.toEqual({
      parallelLimit: 3,
      maxBatchSize: 3,
      queueAutoApprove: false,
      stopOnFailure: false,
      conflictBehavior: 'skip',
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it('normalizes unknown conflict behavior to skip and preserves zero values', async () => {
    mocks.findUnique.mockResolvedValue({
      parallelLimit: 0,
      maxBatchSize: 0,
      queueAutoApprove: false,
      stopOnFailure: false,
      conflictBehavior: 'merge',
    });

    await expect(getExecutionSettings('user-1')).resolves.toEqual({
      parallelLimit: 0,
      maxBatchSize: 0,
      queueAutoApprove: false,
      stopOnFailure: false,
      conflictBehavior: 'skip',
    });
  });

  it('uses hardcoded defaults when row fields are null', async () => {
    mocks.findUnique.mockResolvedValue({
      parallelLimit: null,
      maxBatchSize: null,
      queueAutoApprove: null,
      stopOnFailure: null,
      conflictBehavior: 'fail',
    });

    await expect(getExecutionSettings('user-1')).resolves.toEqual({
      parallelLimit: 3,
      maxBatchSize: 3,
      queueAutoApprove: false,
      stopOnFailure: false,
      conflictBehavior: 'fail',
    });
  });
});
