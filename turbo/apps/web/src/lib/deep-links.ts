// ---------------------------------------------------------------------------
// Keyword detection for deep links (shared across Slack and Telegram)
// ---------------------------------------------------------------------------

interface KeywordLinkMapping {
  keywords: string[];
  label: string;
  path: string;
  /** When set, use this path instead when agentName is provided */
  agentPath?: string;
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
    path: "/settings",
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
      "未设置",
      "未配置",
      "环境变量",
    ],
    label: "Manage secrets & variables",
    path: "/settings?tab=secrets-and-variables",
    agentPath: "/agents/:name/connections",
    emoji: "🔒",
  },
  {
    keywords: [
      "slack token",
      "slack_bot_token",
      "bot token",
      "slack not connected",
    ],
    label: "Slack settings",
    path: "/settings/slack",
    emoji: "⚙️",
  },
  {
    keywords: [
      "connector",
      "mcp server",
      "tool not available",
      "tool not found",
    ],
    label: "Configure connectors",
    path: "/settings?tab=connectors",
    agentPath: "/agents/:name/connections",
    emoji: "🔌",
  },
]);

/**
 * Detect deep links based on keywords in the response text.
 *
 * Scans the text for known configuration-related keywords and returns
 * matching platform deep links (deduplicated by destination path).
 *
 * When agentName is provided, agent-specific paths (e.g. connections page)
 * are used instead of global settings paths where applicable.
 */
export function detectDeepLinks(
  responseText: string,
  platformUrl: string,
  agentName?: string,
): DeepLink[] {
  const lowerText = responseText.toLowerCase();
  const seen = new Set<string>();
  const links: DeepLink[] = [];

  for (const mapping of KEYWORD_LINK_MAPPINGS) {
    const path =
      agentName && mapping.agentPath
        ? mapping.agentPath.replace(":name", encodeURIComponent(agentName))
        : mapping.path;

    if (seen.has(path)) {
      continue;
    }
    const matched = mapping.keywords.some((kw) => lowerText.includes(kw));
    if (matched) {
      seen.add(path);
      links.push({
        emoji: mapping.emoji,
        label: mapping.label,
        url: `${platformUrl}${path}`,
      });
    }
  }

  return links;
}
