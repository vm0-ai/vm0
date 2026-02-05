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

/**
 * Parsed GitHub URL supporting multiple formats
 */
export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  /** Branch name, or null if not specified (use default branch) */
  branch: string | null;
  /** Path within repo, or null if root directory */
  path: string | null;
  /** Full path after github.com/ (unique identifier) */
  fullPath: string;
}

/**
 * Parse any GitHub repository URL into components.
 * Supports multiple URL formats:
 * - https://github.com/owner/repo (plain repo, uses default branch)
 * - https://github.com/owner/repo/tree/branch (root directory with branch)
 * - https://github.com/owner/repo/tree/branch/path (subdirectory)
 *
 * Note: Branch names containing slashes (e.g., feature/foo) may not parse correctly.
 *
 * @param url - GitHub URL
 * @returns Parsed URL components, or null if URL format is invalid
 */
export function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  // Extract full path after github.com/
  const fullPathMatch = url.match(/^https:\/\/github\.com\/(.+)$/);
  if (!fullPathMatch) {
    return null;
  }
  const fullPath = fullPathMatch[1]!;

  // Pattern 1: Plain repo URL (https://github.com/owner/repo or https://github.com/owner/repo/)
  const plainMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/);
  if (plainMatch) {
    return {
      owner: plainMatch[1]!,
      repo: plainMatch[2]!,
      branch: null,
      path: null,
      fullPath,
    };
  }

  // Pattern 2: Tree URL with optional path
  // https://github.com/owner/repo/tree/branch or https://github.com/owner/repo/tree/branch/path
  const treeMatch = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/,
  );
  if (treeMatch) {
    return {
      owner: treeMatch[1]!,
      repo: treeMatch[2]!,
      branch: treeMatch[3]!,
      path: treeMatch[4] ?? null,
      fullPath,
    };
  }

  return null;
}
