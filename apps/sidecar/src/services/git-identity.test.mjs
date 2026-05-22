import { afterEach, describe, expect, it } from 'vitest';
import { getGitIdentityEnv } from './git-identity';

const keys = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'OPENLINEAR_GIT_AUTHOR_NAME',
  'OPENLINEAR_GIT_AUTHOR_EMAIL',
  'OPENLINEAR_GIT_COMMITTER_NAME',
  'OPENLINEAR_GIT_COMMITTER_EMAIL',
];

const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

function clearEnv() {
  for (const key of keys) {
    delete process.env[key];
  }
}

describe('git identity', () => {
  afterEach(() => {
    clearEnv();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) process.env[key] = value;
    }
  });

  it('uses stable OpenLinear defaults', () => {
    clearEnv();

    expect(getGitIdentityEnv()).toEqual({
      GIT_AUTHOR_NAME: 'OpenLinear Agent',
      GIT_AUTHOR_EMAIL: 'agent@openlinear.local',
      GIT_COMMITTER_NAME: 'OpenLinear Agent',
      GIT_COMMITTER_EMAIL: 'agent@openlinear.local',
    });
  });

  it('prefers explicit git env over OpenLinear env and cascades committer fallback', () => {
    clearEnv();
    process.env.OPENLINEAR_GIT_AUTHOR_NAME = 'OpenLinear Bot';
    process.env.OPENLINEAR_GIT_AUTHOR_EMAIL = 'bot@example.com';
    process.env.GIT_AUTHOR_NAME = 'Git Bot';

    expect(getGitIdentityEnv()).toEqual({
      GIT_AUTHOR_NAME: 'Git Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_NAME: 'Git Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    });
  });

  it('allows committer identity to differ from author identity', () => {
    clearEnv();
    process.env.OPENLINEAR_GIT_AUTHOR_NAME = 'Author';
    process.env.OPENLINEAR_GIT_AUTHOR_EMAIL = 'author@example.com';
    process.env.OPENLINEAR_GIT_COMMITTER_NAME = 'Committer';
    process.env.OPENLINEAR_GIT_COMMITTER_EMAIL = 'committer@example.com';

    expect(getGitIdentityEnv()).toEqual({
      GIT_AUTHOR_NAME: 'Author',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_COMMITTER_NAME: 'Committer',
      GIT_COMMITTER_EMAIL: 'committer@example.com',
    });
  });
});
