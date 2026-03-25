// ---------------------------------------------------------------------------
// Keyword detection for deep links (shared across Slack and Telegram)
// ---------------------------------------------------------------------------

type KeywordCategory = "connector";

interface KeywordLinkMapping {
  keywords: string[];
  label: string;
  category: KeywordCategory;
  emoji: string;
}

export interface DeepLink {
  emoji: string;
  label: string;
  url: string;
}

const KEYWORD_LINK_MAPPINGS: readonly KeywordLinkMapping[] = Object.freeze([
  {
    keywords: [
      "secret",
      "missing variable",
      "env var",
      "environment variable",
      "api key",
      "api_key",
      "apikey",
      "not set",
      "connector",
      "mcp server",
      "tool not available",
      "tool not found",
    ],
    label: "Configure connectors",
    category: "connector",
    emoji: "🔌",
  },
]);

function buildPath(category: KeywordCategory, agentId?: string): string {
  // Connector links route to the agent's team page with connectors tab
  if (category === "connector" && agentId) {
    return `/team/${encodeURIComponent(agentId)}?tab=connectors`;
  }
  return "/team";
}

/**
 * Build the deep link URL for configuring model providers.
 * Opens the org manage dialog directly on the providers tab.
 */
export function buildModelProviderLink(appUrl: string): DeepLink {
  return {
    emoji: "🔑",
    label: "Configure model providers",
    url: `${appUrl}/?settings=providers`,
  };
}

/**
 * Detect deep links based on keywords in the response text.
 *
 * Scans the text for known configuration-related keywords and returns
 * matching platform deep links (deduplicated by destination path).
 *
 * When `agentId` is provided, connector links point to
 * `/team/{agentId}?tab=connectors` instead of the generic team page.
 */
export function detectDeepLinks(
  responseText: string,
  appUrl: string,
  agentId?: string,
): DeepLink[] {
  const lowerText = responseText.toLowerCase();
  const seen = new Set<string>();
  const links: DeepLink[] = [];

  for (const mapping of KEYWORD_LINK_MAPPINGS) {
    const path = buildPath(mapping.category, agentId);
    if (seen.has(path)) {
      continue;
    }
    const matched = mapping.keywords.some((kw) => lowerText.includes(kw));
    if (matched) {
      seen.add(path);
      links.push({
        emoji: mapping.emoji,
        label: mapping.label,
        url: `${appUrl}${path}`,
      });
    }
  }

  return links;
}

/**
 * Detect which keyword categories are present in the given text.
 *
 * Returns the set of matched categories without generating URLs —
 * useful when callers only need to know *which* issue types were
 * detected, not the full deep-link objects.
 */
export function detectIssueCategories(text: string): Set<KeywordCategory> {
  const lowerText = text.toLowerCase();
  const categories = new Set<KeywordCategory>();

  for (const mapping of KEYWORD_LINK_MAPPINGS) {
    if (mapping.keywords.some((kw) => lowerText.includes(kw))) {
      categories.add(mapping.category);
    }
  }

  return categories;
}
