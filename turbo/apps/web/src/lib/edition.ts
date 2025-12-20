/**
 * Edition helpers for Community vs Cloud edition detection
 */

export type Edition = "community" | "cloud";

/**
 * Get the current edition from environment
 *
 * Must be explicitly configured via VM0_EDITION environment variable.
 * Defaults to "cloud" if not specified.
 */
export function getEdition(): Edition {
  const edition = process.env.VM0_EDITION;

  if (edition === "community") {
    return "community";
  }

  // Default to cloud edition
  return "cloud";
}

export function isCommunityEdition(): boolean {
  return getEdition() === "community";
}

export function isCloudEdition(): boolean {
  return getEdition() === "cloud";
}
