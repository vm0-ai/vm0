/**
 * GitHub URL parsing utilities
 *
 * Provides parsing for GitHub tree URLs used in skills and other resources.
 */

export interface ParsedGitHubTreeUrl {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  /** Last segment of path (used for mount directory name) */
  skillName: string;
  /** Full path after github.com/ (unique identifier) */
  fullPath: string;
}

/**
 * Parse a GitHub tree URL into its components
 * Expected format: https://github.com/{owner}/{repo}/tree/{branch}/{path}
 *
 * Note: Branch names containing slashes (e.g., feature/foo) may not parse correctly.
 * The fullPath field is always correct and used for unique storage naming.
 *
 * @param url - GitHub tree URL
 * @returns Parsed URL components, or null if URL format is invalid
 */
export function parseGitHubTreeUrl(url: string): ParsedGitHubTreeUrl | null {
  // First, extract the full path after github.com/ (always correct)
  const fullPathMatch = url.match(/^https:\/\/github\.com\/(.+)$/);
  if (!fullPathMatch) {
    return null;
  }
  const fullPath = fullPathMatch[1]!;

  // Parse components (may be incorrect for branches with slashes)
  const regex =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/;
  const match = url.match(regex);

  if (!match) {
    return null;
  }

  const [, owner, repo, branch, pathPart] = match;
  const pathSegments = pathPart!.split("/").filter(Boolean);
  const skillName = pathSegments[pathSegments.length - 1] || pathPart!;

  return {
    owner: owner!,
    repo: repo!,
    branch: branch!,
    path: pathPart!,
    skillName,
    fullPath,
  };
}

/**
 * Get skill name from path (last segment)
 */
export function getSkillNameFromPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] || path;
}
