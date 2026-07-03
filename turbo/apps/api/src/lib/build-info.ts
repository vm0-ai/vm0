const GIT_COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/u;

export function normalizeBuildCommitSha(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const commitSha = value.trim().toLowerCase();
  return GIT_COMMIT_SHA_REGEX.test(commitSha) ? commitSha : null;
}
