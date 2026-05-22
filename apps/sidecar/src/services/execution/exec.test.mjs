import { describe, expect, it } from 'vitest';
import { execFileAsync } from './exec';

describe('execution exec helpers', () => {
  it('returns stdout and stderr as strings', async () => {
    const result = await execFileAsync(process.execPath, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err");',
    ]);

    expect(result).toEqual({ stdout: 'out', stderr: 'err' });
  });

  it('passes argv entries without shell interpolation', async () => {
    const result = await execFileAsync(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      'literal; echo injected',
    ]);

    expect(result.stdout).toBe('literal; echo injected');
  });
});
