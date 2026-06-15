interface GithubInstallationTarget {
  readonly targetName: string | null;
  readonly targetType: string | null;
}

function githubAccountLabel(targetName: string): string {
  const trimmed = targetName.trim();
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

export function githubInstallationTargetName(
  target: GithubInstallationTarget,
): string | null {
  const targetName = target.targetName?.trim();
  if (!targetName) {
    return null;
  }

  const targetType = target.targetType?.trim().toLowerCase();
  if (targetType === "organization" || targetType === "user") {
    return githubAccountLabel(targetName);
  }
  if (targetType === "repository") {
    return targetName;
  }

  return targetName;
}
