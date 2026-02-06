import { prisma } from '@openlinear/db';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI || 'http://localhost:3001/api/auth/github/callback';

export interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  avatar_url: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  description: string | null;
}

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const patterns = [
    /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/,
    /^git@github\.com:([^\/]+)\/([^\/]+?)(\.git)?$/,
    /^([^\/]+)\/([^\/]+)$/,
  ];
  
  for (const pattern of patterns) {
    const match = url.trim().match(pattern);
    if (match) {
      return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
    }
  }
  return null;
}

export async function fetchPublicRepo(owner: string, repo: string): Promise<GitHubRepo> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'OpenLinear',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Repository ${owner}/${repo} not found or is private`);
    }
    throw new Error(`Failed to fetch repository: ${response.statusText}`);
  }

  return (await response.json()) as GitHubRepo;
}

export async function addProjectByUrl(url: string): Promise<{
  id: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  isActive: boolean;
}> {
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    throw new Error('Invalid GitHub URL format');
  }

  const repo = await fetchPublicRepo(parsed.owner, parsed.repo);
  
  if (repo.private) {
    throw new Error('Private repositories require authentication');
  }

  const existing = await prisma.project.findFirst({
    where: { githubRepoId: repo.id, userId: null },
  });

  if (existing) {
    return prisma.project.update({
      where: { id: existing.id },
      data: { isActive: true },
    });
  }

  await prisma.project.updateMany({
    where: { userId: null },
    data: { isActive: false },
  });

  return prisma.project.create({
    data: {
      githubRepoId: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
      isActive: true,
    },
  });
}

export function getAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_REDIRECT_URI,
    scope: 'read:user user:email repo',
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const data = (await response.json()) as TokenResponse;
  
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  return data.access_token!;
}

export async function getGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch GitHub user');
  }

  return (await response.json()) as GitHubUser;
}

export async function getGitHubRepos(accessToken: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await fetch(
      `https://api.github.com/user/repos?page=${page}&per_page=${perPage}&sort=updated&affiliation=owner,collaborator`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) {
      throw new Error('Failed to fetch repositories');
    }

    const data = (await response.json()) as GitHubRepo[];
    repos.push(...data);

    if (data.length < perPage) break;
    page++;
  }

  return repos;
}

export async function createOrUpdateUser(
  githubUser: GitHubUser,
  accessToken: string
) {
  return prisma.user.upsert({
    where: { githubId: githubUser.id },
    update: {
      username: githubUser.login,
      email: githubUser.email,
      avatarUrl: githubUser.avatar_url,
      accessToken,
    },
    create: {
      githubId: githubUser.id,
      username: githubUser.login,
      email: githubUser.email,
      avatarUrl: githubUser.avatar_url,
      accessToken,
    },
  });
}

export async function getUserById(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: { projects: true },
  });
}

export async function getUserProjects(userId: string) {
  return prisma.project.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function addProject(
  userId: string,
  repo: GitHubRepo,
  isActive = false
) {
  return prisma.project.upsert({
    where: {
      userId_githubRepoId: { userId, githubRepoId: repo.id },
    },
    update: {
      name: repo.name,
      fullName: repo.full_name,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
      isActive,
    },
    create: {
      githubRepoId: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
      userId,
      isActive,
    },
  });
}

export async function setActiveProject(userId: string, projectId: string) {
  await prisma.project.updateMany({
    where: { userId },
    data: { isActive: false },
  });

  return prisma.project.update({
    where: { id: projectId },
    data: { isActive: true },
  });
}

export async function getActiveProject(userId: string) {
  return prisma.project.findFirst({
    where: { userId, isActive: true },
  });
}
