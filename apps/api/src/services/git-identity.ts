export function getGitIdentityEnv(): Record<string, string> {
  const name =
    process.env.GIT_AUTHOR_NAME ||
    process.env.OPENLINEAR_GIT_AUTHOR_NAME ||
    'OpenLinear Agent'
  const email =
    process.env.GIT_AUTHOR_EMAIL ||
    process.env.OPENLINEAR_GIT_AUTHOR_EMAIL ||
    'agent@openlinear.local'

  const committerName =
    process.env.GIT_COMMITTER_NAME ||
    process.env.OPENLINEAR_GIT_COMMITTER_NAME ||
    name
  const committerEmail =
    process.env.GIT_COMMITTER_EMAIL ||
    process.env.OPENLINEAR_GIT_COMMITTER_EMAIL ||
    email

  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: committerEmail,
  }
}
