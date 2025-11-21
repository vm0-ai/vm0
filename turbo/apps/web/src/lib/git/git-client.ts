/**
 * Git Client
 * Handles Git repository operations for volume mounting
 */

/**
 * Validate Git URL format
 * @param url - Git repository URL
 * @returns True if valid HTTPS Git URL
 */
export function validateGitUrl(url: string): boolean {
  // Support HTTPS URLs only for MVP
  const httpsPattern = /^https:\/\/.+\/.+\.git$/;
  return httpsPattern.test(url);
}

/**
 * Normalize Git URL to full HTTPS format
 * @param uri - Git repository URI (can be full URL or short format)
 * @returns Normalized HTTPS URL ending in .git
 */
export function normalizeGitUrl(uri: string): string {
  // If already a valid URL (https/http), return with .git suffix
  if (uri.startsWith("https://") || uri.startsWith("http://")) {
    return uri.endsWith(".git") ? uri : `${uri}.git`;
  }

  // If it's an SSH or git protocol URL, return as-is (will be rejected by validation)
  if (
    uri.startsWith("git@") ||
    uri.startsWith("ssh://") ||
    uri.startsWith("git://")
  ) {
    return uri;
  }

  // Otherwise treat as GitHub short format (e.g., "owner/repo")
  // Remove any leading/trailing slashes
  const cleaned = uri.replace(/^\/+|\/+$/g, "");
  return `https://github.com/${cleaned}.git`;
}

/**
 * Build authenticated Git URL with token
 * @param url - Base Git URL
 * @param token - Authentication token (optional)
 * @returns URL with embedded token for authentication
 */
export function buildAuthenticatedUrl(url: string, token?: string): string {
  if (!token) {
    return url;
  }

  // Parse URL and inject token
  // https://github.com/user/repo.git -> https://token@github.com/user/repo.git
  const urlObj = new URL(url);
  urlObj.username = token;
  return urlObj.toString();
}

/**
 * Sanitize Git URL for logging (hide token)
 * @param url - Git URL that may contain token
 * @returns Sanitized URL with token masked
 */
export function sanitizeGitUrlForLogging(url: string): string {
  try {
    const urlObj = new URL(url);
    if (urlObj.username) {
      urlObj.username = "***";
    }
    if (urlObj.password) {
      urlObj.password = "***";
    }
    return urlObj.toString();
  } catch {
    return url;
  }
}

/**
 * Build Git clone command
 * @param url - Git repository URL (with auth if needed)
 * @param branch - Branch to clone
 * @param mountPath - Target directory path
 * @returns Git clone command string
 */
export function buildGitCloneCommand(
  url: string,
  branch: string,
  mountPath: string,
): string {
  // Use single-branch clone for efficiency
  return `git clone --single-branch --branch "${branch}" --depth 1 "${url}" "${mountPath}"`;
}
