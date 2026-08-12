export const ZERO_MIGRATION_BRIDGE_CONFIG = {
  minimumVersion: "0.34.0",
  downloadUrl:
    "https://api.vm0.ai/api/okou/desktop/updates/stable/darwin/arm64/dmg",
  reminderDelayMs: 7 * 24 * 60 * 60 * 1_000,
  copy: {
    title: "Zero Computer Use is moving to Okou",
    detail:
      "Okou is a separate app. Download it, sign in again, and grant Accessibility, Screen Recording, and browser Automation permissions again. Zero will keep working until you choose to migrate.",
    pausedTitle: "Zero is paused while you set up Okou",
    pausedDetail:
      "Finish installing and setting up Okou. If that does not work, you can resume Zero and try again later.",
  },
} as const;

function releaseVersionParts(value: string): readonly number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) {
    return null;
  }
  return match.slice(1).map(Number);
}

export function isVersionAtLeast(
  currentVersion: string,
  minimumVersion: string,
): boolean {
  const current = releaseVersionParts(currentVersion);
  const minimum = releaseVersionParts(minimumVersion);
  if (!current || !minimum) {
    return false;
  }
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] !== minimum[index]) {
      return (current[index] ?? 0) > (minimum[index] ?? 0);
    }
  }
  return true;
}

export function isTrustedZeroMigrationDownloadUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      url.origin === "https://api.vm0.ai" &&
      url.pathname === "/api/okou/desktop/updates/stable/darwin/arm64/dmg" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
