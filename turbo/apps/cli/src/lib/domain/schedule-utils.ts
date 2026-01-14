import { existsSync, readFileSync } from "fs";
import { parse as parseYaml } from "yaml";

const CONFIG_FILE = "vm0.yaml";

/**
 * vm0.yaml structure for agent compose
 */
export interface AgentComposeConfig {
  version: string;
  agents: Record<string, unknown>;
}

/**
 * Result of loading agent name from vm0.yaml
 */
export interface LoadAgentNameResult {
  agentName: string | null;
  error?: string;
}

/**
 * Load vm0.yaml and return the first agent name.
 * Returns error message if file exists but cannot be parsed.
 */
export function loadAgentName(): LoadAgentNameResult {
  if (!existsSync(CONFIG_FILE)) {
    return { agentName: null };
  }
  try {
    const content = readFileSync(CONFIG_FILE, "utf8");
    const config = parseYaml(content) as AgentComposeConfig;
    const agentNames = Object.keys(config.agents || {});
    return { agentName: agentNames[0] || null };
  } catch (err) {
    return {
      agentName: null,
      error: err instanceof Error ? err.message : "Failed to parse vm0.yaml",
    };
  }
}

/**
 * Format a date string as relative time (e.g., "in 2h", "3d ago")
 */
export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "-";

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffAbs = Math.abs(diffMs);

  const minutes = Math.floor(diffAbs / (1000 * 60));
  const hours = Math.floor(diffAbs / (1000 * 60 * 60));
  const days = Math.floor(diffAbs / (1000 * 60 * 60 * 24));

  const isPast = diffMs < 0;

  if (days > 0) {
    return isPast ? `${days}d ago` : `in ${days}d`;
  } else if (hours > 0) {
    return isPast ? `${hours}h ago` : `in ${hours}h`;
  } else if (minutes > 0) {
    return isPast ? `${minutes}m ago` : `in ${minutes}m`;
  } else {
    return isPast ? "just now" : "soon";
  }
}

/**
 * Format a date string with both absolute and relative time
 * e.g., "2025-01-14 09:00:00 UTC (in 2h)"
 */
export function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "-";

  const date = new Date(dateStr);
  const formatted = date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
  const relative = formatRelativeTime(dateStr);

  return `${formatted} (${relative})`;
}
