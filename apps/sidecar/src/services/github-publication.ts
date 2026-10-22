export function isGithubPullRequestUrl(value: unknown, fullName: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const prefix = `/${fullName}/pull/`;
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password
      && !url.search && !url.hash && url.pathname.startsWith(prefix)
      && /^[1-9][0-9]*\/?$/.test(url.pathname.slice(prefix.length));
  } catch { return false; }
}

export async function publishGithubPullRequest(input: {
  fullName: string;
  branchName: string;
  defaultBranch: string;
  title: string;
  body: string;
  accessToken: string | null;
  assertActive?: () => void;
}): Promise<string> {
  if (!input.accessToken) throw new Error('GitHub authentication is required to create the pull request');
  const [owner, repo] = input.fullName.split('/');
  if (!owner || !repo || input.fullName.split('/').length !== 2
    || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) || owner.length > 39
    || !/^[A-Za-z0-9_.-]+$/.test(repo) || repo === '.' || repo === '..') {
    throw new Error('Invalid repository identity for publication');
  }
  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
  const headers = { Authorization: `Bearer ${input.accessToken}`, Accept: 'application/vnd.github.v3+json' };
  let response: Response | undefined;
  let ambiguous = false;
  try {
    input.assertActive?.();
    response = await fetch(baseUrl, {
      method: 'POST', signal: AbortSignal.timeout(30_000), headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: input.title, head: input.branchName, base: input.defaultBranch, body: input.body }),
    });
  } catch (error) {
    input.assertActive?.();
    if (!(error instanceof TypeError) && !(error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))) throw error;
    ambiguous = true;
  }
  if (response?.ok) {
    try {
      const data: unknown = await response.json();
      if (data && typeof data === 'object' && 'html_url' in data && isGithubPullRequestUrl(data.html_url, input.fullName)) return data.html_url;
      throw new Error('GitHub returned an invalid pull request receipt');
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))) throw error;
      ambiguous = true; // Accepted mutation, but its response body was lost.
    }
  }
  if (!ambiguous && response?.status !== 422) throw new Error(`GitHub pull request creation failed (HTTP ${response?.status ?? 'unknown'})`);

  // Reconcile a dispatched mutation; never blindly retry a PR creation POST.
  input.assertActive?.();
  const existing = await fetch(`${baseUrl}?head=${encodeURIComponent(owner + ':' + input.branchName)}&base=${encodeURIComponent(input.defaultBranch)}&state=open`, {
    headers, signal: AbortSignal.timeout(30_000),
  });
  if (existing.ok) {
    const data: unknown = await existing.json();
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && typeof item === 'object' && 'html_url' in item && isGithubPullRequestUrl(item.html_url, input.fullName)) return item.html_url;
      }
    }
  }
  throw new Error('Branch was pushed, but pull request creation could not be confirmed');
}
