import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishGithubPullRequest } from './github-publication';

const fetchMock = vi.fn<typeof fetch>();
const pullRequestUrl = 'https://github.com/acme/repo/pull/123';
const apiUrl = 'https://api.github.com/repos/acme/repo/pulls';

function input(overrides: Partial<Parameters<typeof publishGithubPullRequest>[0]> = {}) {
  return {
    fullName: 'acme/repo', branchName: 'openlinear/attempt-a', defaultBranch: 'main',
    title: 'Fix the publication receipt', body: 'Offline contract fixture', accessToken: 'fixture-token',
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 201): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function methods() {
  return fetchMock.mock.calls.map(([, options]) => options?.method ?? 'GET');
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GitHub publication receipt contract', () => {
  it('returns a real pull request receipt and dispatches exactly one bounded POST', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValueOnce(jsonResponse({ html_url: pullRequestUrl }));
    await expect(publishGithubPullRequest(input())).resolves.toBe(pullRequestUrl);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(apiUrl, expect.objectContaining({
      method: 'POST', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' }),
      body: expect.any(String),
    }));
    const body = fetchMock.mock.calls[0][1]?.body;
    if (typeof body !== 'string') throw new Error('Expected a JSON publication body');
    expect(JSON.parse(body)).toEqual({ title: 'Fix the publication receipt', head: 'openlinear/attempt-a',
      base: 'main', body: 'Offline contract fixture' });
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it('accepts a valid receipt with the normalized default HTTPS port', async () => {
    const receipt = 'https://github.com:443/acme/repo/pull/123';
    fetchMock.mockResolvedValueOnce(jsonResponse({ html_url: receipt }));
    await expect(publishGithubPullRequest(input())).resolves.toBe(receipt);
    expect(methods()).toEqual(['POST']);
  });

  it.each([null, ''])('rejects missing GitHub authentication %j before fetch', async (accessToken) => {
    await expect(publishGithubPullRequest(input({ accessToken }))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['', 'acme', '/repo', 'acme/', 'acme/repo/extra', 'https://github.com/acme/repo',
    'acme /repo', 'acme/repo?base=other'])('rejects invalid repository identity %j before fetch', async (fullName) => {
    await expect(publishGithubPullRequest(input({ fullName }))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'https://github.com/acme/repo/compare/main...openlinear/attempt-a',
    'https://github.com/other/repo/pull/123',
    'https://github.com/acme/other/pull/123',
    'http://github.com/acme/repo/pull/123',
    'https://github.example/acme/repo/pull/123',
    'https://user:password@github.com/acme/repo/pull/123',
    'https://github.com:444/acme/repo/pull/123',
    'https://github.com/acme/repo/pull/123?proof=missing',
    'https://github.com/acme/repo/pull/123#comment',
    'https://github.com/acme/repo/pull/not-a-number',
    'https://github.com/acme/repo/pull/123/files',
    '/acme/repo/pull/123', null, 123,
  ])('rejects a successful HTTP response with an invalid or mismatched receipt %j', async (htmlUrl) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ html_url: htmlUrl }));
    await expect(publishGithubPullRequest(input())).rejects.toThrow();
    expect(methods()).toEqual(['POST']);
  });

  it.each([{ data: {} }, { data: [] }, { data: null }])('rejects a response with no pull request receipt $data', async ({ data }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(data));
    await expect(publishGithubPullRequest(input())).rejects.toThrow();
    expect(methods()).toEqual(['POST']);
  });

  it.each([401, 403, 404, 500, 503])('rejects HTTP %i without a lookup or duplicate mutation', async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'fixture HTTP failure' }, status));
    await expect(publishGithubPullRequest(input())).rejects.toThrow();
    expect(methods()).toEqual(['POST']);
  });

  it('rejects a non-ambiguous thrown error without reconciliation', async () => {
    const failure = new Error('fixture implementation failure');
    fetchMock.mockRejectedValueOnce(failure);
    await expect(publishGithubPullRequest(input())).rejects.toBe(failure);
    expect(methods()).toEqual(['POST']);
  });
});

describe('reconciliation after duplicate or ambiguous GitHub dispatch', () => {
  it.each([
    { name: '422', rejection: null },
    { name: 'TypeError', rejection: new TypeError('response connection lost') },
    { name: 'AbortError', rejection: new DOMException('request aborted', 'AbortError') },
    { name: 'TimeoutError', rejection: new DOMException('request timed out', 'TimeoutError') },
  ])('reconciles $name with one scoped GET and never a second POST', async ({ rejection }) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    if (rejection) fetchMock.mockRejectedValueOnce(rejection);
    else fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'already exists' }, 422));
    fetchMock.mockResolvedValueOnce(jsonResponse([{ html_url: pullRequestUrl }], 200));
    await expect(publishGithubPullRequest(input())).resolves.toBe(pullRequestUrl);
    expect(methods()).toEqual(['POST', 'GET']);
    const [lookup, options] = fetchMock.mock.calls[1];
    const url = new URL(String(lookup));
    expect(url.origin + url.pathname).toBe(apiUrl);
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      head: 'acme:openlinear/attempt-a', base: 'main', state: 'open',
    });
    expect(options?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer fixture-token' }));
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(timeout.mock.calls).toEqual([[30_000], [30_000]]);
  });

  it.each([
    { data: [] }, { data: {} }, { data: [{ html_url: 'https://github.com/other/repo/pull/123' }] },
    { data: [{ html_url: 'https://github.com/acme/repo/compare/main...openlinear/attempt-a' }] },
  ])('rejects unconfirmed reconciliation receipts $data without a second mutation', async ({ data }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'already exists' }, 422));
    fetchMock.mockResolvedValueOnce(jsonResponse(data, 200));
    await expect(publishGithubPullRequest(input())).rejects.toThrow();
    expect(methods()).toEqual(['POST', 'GET']);
  });

  it('reconciles a response body transport failure after the POST was accepted', async () => {
    const response = jsonResponse({ html_url: pullRequestUrl });
    vi.spyOn(response, 'json').mockRejectedValueOnce(new TypeError('response body connection lost'));
    fetchMock.mockResolvedValueOnce(response);
    fetchMock.mockResolvedValueOnce(jsonResponse([{ html_url: pullRequestUrl }], 200));
    await expect(publishGithubPullRequest(input())).resolves.toBe(pullRequestUrl);
    expect(methods()).toEqual(['POST', 'GET']);
  });

  it('rejects invalid response JSON without retrying publication', async () => {
    fetchMock.mockResolvedValueOnce(new Response('invalid-json', { status: 201 }));
    await expect(publishGithubPullRequest(input())).rejects.toThrow();
    expect(methods()).toEqual(['POST']);
  });

  it('rejects a failed reconciliation HTTP response without retrying', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('lost response'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'unavailable' }, 503));
    await expect(publishGithubPullRequest(input())).rejects.toThrow();
    expect(methods()).toEqual(['POST', 'GET']);
  });

  it('rejects a failed reconciliation transport without retrying', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('lost response'));
    fetchMock.mockRejectedValueOnce(new TypeError('lookup unavailable'));
    await expect(publishGithubPullRequest(input())).rejects.toThrow();
    expect(methods()).toEqual(['POST', 'GET']);
  });
});

describe('cancellation around publication dispatch', () => {
  it('checks the current fence before issuing any request', async () => {
    const cancelled = new Error('fixture cancelled');
    const assertActive = vi.fn(() => { throw cancelled; });
    await expect(publishGithubPullRequest(input({ assertActive }))).rejects.toBe(cancelled);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a real receipt from an already dispatched POST even if cancellation arrived while waiting', async () => {
    let active = true;
    const assertActive = vi.fn(() => { if (!active) throw new Error('fixture cancelled'); });
    fetchMock.mockImplementationOnce(async () => {
      active = false;
      return jsonResponse({ html_url: pullRequestUrl });
    });
    await expect(publishGithubPullRequest(input({ assertActive }))).resolves.toBe(pullRequestUrl);
    expect(methods()).toEqual(['POST']);
    expect(assertActive).toHaveBeenCalledOnce();
  });

  it.each(['422', 'ambiguous'] as const)('stops before reconciliation when cancellation arrives after %s dispatch', async (outcome) => {
    let active = true;
    const cancelled = new Error('fixture cancelled');
    const assertActive = () => { if (!active) throw cancelled; };
    fetchMock.mockImplementationOnce(async () => {
      active = false;
      if (outcome === 'ambiguous') throw new TypeError('response connection lost');
      return jsonResponse({ message: 'already exists' }, 422);
    });
    await expect(publishGithubPullRequest(input({ assertActive }))).rejects.toBe(cancelled);
    expect(methods()).toEqual(['POST']);
  });
});
