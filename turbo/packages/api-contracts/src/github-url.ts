interface ParsedGitHubTreeUrl {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  branch: string | null;
}

export function parseGitHubTreeUrl(url: string): ParsedGitHubTreeUrl | null {
  let normalizedUrl = url;
  while (normalizedUrl.endsWith("/")) {
    normalizedUrl = normalizedUrl.slice(0, -1);
  }

  const match = normalizedUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/,
  );
  if (!match) {
    return null;
  }

  return {
    owner: match[1]!,
    repo: match[2]!,
    branch: match[3]!,
    path: match[4] ?? "",
  };
}

function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  let normalizedUrl = url;
  while (normalizedUrl.endsWith("/")) {
    normalizedUrl = normalizedUrl.slice(0, -1);
  }

  const plainMatch = normalizedUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/,
  );
  if (plainMatch) {
    return {
      owner: plainMatch[1]!,
      repo: plainMatch[2]!,
      branch: null,
    };
  }

  const treeMatch = normalizedUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/,
  );
  if (treeMatch) {
    return {
      owner: treeMatch[1]!,
      repo: treeMatch[2]!,
      branch: treeMatch[3]!,
    };
  }

  return null;
}

const DEFAULT_FIREWALLS_OWNER = "vm0-ai";
const DEFAULT_FIREWALLS_REPO = "vm0-firewalls";
const DEFAULT_FIREWALLS_BRANCH = "main";
const FIREWALL_NAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$/;

export function resolveFirewallRef(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error("Firewall reference cannot be empty");
  }

  if (!trimmed.includes("/") && !trimmed.startsWith("https://")) {
    if (!FIREWALL_NAME_PATTERN.test(trimmed)) {
      throw new Error(
        `Invalid firewall name "${trimmed}": must be alphanumeric with hyphens, dots, or underscores`,
      );
    }
    return `https://github.com/${DEFAULT_FIREWALLS_OWNER}/${DEFAULT_FIREWALLS_REPO}/tree/${DEFAULT_FIREWALLS_BRANCH}/${trimmed}`;
  }

  const parsed = parseGitHubUrl(trimmed);
  if (!parsed) {
    throw new Error(
      `Invalid firewall URL: ${trimmed}. Expected a bare firewall name (e.g. "custom-api") or a GitHub URL (https://github.com/{owner}/{repo}[/tree/{branch}[/path]])`,
    );
  }

  if (!parsed.branch) {
    return `https://github.com/${parsed.owner}/${parsed.repo}/tree/${DEFAULT_FIREWALLS_BRANCH}`;
  }

  return trimmed;
}
