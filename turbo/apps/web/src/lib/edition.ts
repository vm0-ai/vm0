/**
 * Edition helpers for Community vs Cloud edition detection
 */

export type Edition = "community" | "cloud";

/**
 * Get the current edition from environment
 * Defaults to 'cloud' for backward compatibility
 */
export function getEdition(): Edition {
  const edition = process.env.VM0_EDITION;
  if (edition === "community") {
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
