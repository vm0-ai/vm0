const GIT_COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/u;

function normalizeBuildCommitSha(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const commitSha = value.trim().toLowerCase();
  return GIT_COMMIT_SHA_REGEX.test(commitSha) ? commitSha : null;
}

function normalizeBuildVersion(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const version = value.trim();
  return version.length > 0 ? version : null;
}

export function getBuildCommitSha(): string | null {
  return normalizeBuildCommitSha(import.meta.env.VITE_GIT_COMMIT_SHA);
}

export function getBuildVersion(): string | null {
  return normalizeBuildVersion(import.meta.env.VITE_APP_VERSION);
}
