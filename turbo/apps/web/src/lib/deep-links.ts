// ---------------------------------------------------------------------------
// Keyword detection for deep links (shared across Slack and Telegram)
// ---------------------------------------------------------------------------

interface KeywordLinkMapping {
  keywords: string[];
  label: string;
  path: string;
  emoji: string;
}

export interface DeepLink {
  emoji: string;
  label: string;
  url: string;
}

const KEYWORD_LINK_MAPPINGS: readonly KeywordLinkMapping[] = Object.freeze([
  {
    keywords: ["model provider", "provider not configured"],
    label: "Configure model providers",
    path: "/zero/settings",
    emoji: "🔑",
  },
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
    path: "/zero/meet",
    emoji: "🔌",
  },
]);

/**
 * Detect deep links based on keywords in the response text.
 *
 * Scans the text for known configuration-related keywords and returns
 * matching platform deep links (deduplicated by destination path).
 */
export function detectDeepLinks(
  responseText: string,
  platformUrl: string,
): DeepLink[] {
  const lowerText = responseText.toLowerCase();
  const seen = new Set<string>();
  const links: DeepLink[] = [];

  for (const mapping of KEYWORD_LINK_MAPPINGS) {
    if (seen.has(mapping.path)) {
      continue;
    }
    const matched = mapping.keywords.some((kw) => lowerText.includes(kw));
    if (matched) {
      seen.add(mapping.path);
      links.push({
        emoji: mapping.emoji,
        label: mapping.label,
        url: `${platformUrl}${mapping.path}`,
      });
    }
  }

  return links;
}
