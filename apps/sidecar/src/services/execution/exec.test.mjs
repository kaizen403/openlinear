import { describe, expect, it, vi } from 'vitest';
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

  it('coerces Buffer stdout/stderr to utf8 strings', async () => {
    // Force Buffer outputs by omitting encoding (default is Buffer when no encoding set
    // on raw child_process exec). The current implementation passes maxBuffer and any
    // caller options through, so we exercise the Buffer-to-string fallback here.
    const result = await execFileAsync(
      process.execPath,
      ['-e', 'process.stdout.write("buf"); process.stderr.write("err");'],
      { encoding: 'buffer' },
    );

    expect(result.stdout).toBe('buf');
    expect(result.stderr).toBe('err');
  });
});
