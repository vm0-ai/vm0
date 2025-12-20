/**
 * Edition helpers for Community vs Cloud edition detection
 */

export type Edition = "community" | "cloud";

/**
 * Get the current edition from environment
 *
 * Detection logic:
 * 1. If VM0_EDITION is explicitly set, use that value
 * 2. If Clerk keys are not configured, auto-detect as 'community'
 * 3. Otherwise, default to 'cloud'
 */
export function getEdition(): Edition {
  const edition = process.env.VM0_EDITION;

  // Explicit configuration takes precedence
  if (edition === "community") {
    return "community";
  }
  if (edition === "cloud") {
    return "cloud";
  }

  // Auto-detect: if no Clerk keys configured, use community edition
  const hasClerkKeys =
    process.env.CLERK_SECRET_KEY &&
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (!hasClerkKeys) {
    return "community";
  }

  return "cloud";
}

export function isCommunityEdition(): boolean {
  return getEdition() === "community";
}

export function isCloudEdition(): boolean {
  return getEdition() === "cloud";
}
