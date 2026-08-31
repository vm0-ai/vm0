const GIT_COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/u;
const APP_VERSION_SEARCH_PARAMETER = "okou-app-version";

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
  const runtimeDocument = globalThis.document;
  return normalizeBuildCommitSha(
    runtimeDocument?.head.querySelector<HTMLMetaElement>(
      'meta[name="okou-app-git-commit-sha"]',
    )?.content,
  );
}

export function getBuildVersion(): string | null {
  const runtimeDocument = globalThis.document;
  const value = runtimeDocument
    ? runtimeDocument.head.querySelector<HTMLMetaElement>(
        'meta[name="okou-app-version"]',
      )?.content
    : new URL(globalThis.location.href).searchParams.get(
        APP_VERSION_SEARCH_PARAMETER,
      );
  return normalizeBuildVersion(value);
}
