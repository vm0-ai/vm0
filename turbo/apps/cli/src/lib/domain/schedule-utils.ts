import { existsSync, readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { extractVariableReferences, groupVariablesBySource } from "@vm0/core";
import { listSchedules } from "../api";

const CONFIG_FILE = "vm0.yaml";

/**
 * vm0.yaml structure for agent compose
 */
interface AgentComposeConfig {
  version: string;
  agents: Record<string, unknown>;
}

/**
 * Result of loading agent name from vm0.yaml
 */
interface LoadAgentNameResult {
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
 * e.g., "2025-01-14 09:00 (in 2h)"
 * Uses local timezone, but doesn't include timezone in output (shown separately)
 */
export function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "-";

  const date = new Date(dateStr);

  // Format: YYYY-MM-DD HH:MM (no seconds, no timezone - shown separately)
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  const formatted = `${year}-${month}-${day} ${hours}:${minutes}`;
  const relative = formatRelativeTime(dateStr);

  return `${formatted} (${relative})`;
}

/**
 * Frequency type for schedule wizard
 */
export type ScheduleFrequency = "daily" | "weekly" | "monthly" | "once";

/**
 * Generate cron expression from user-friendly inputs
 * @param frequency - Schedule frequency type
 * @param time - Time in HH:MM format (24-hour)
 * @param day - Day of week (0-6, Sun=0) for weekly, or day of month (1-31) for monthly
 * @returns Cron expression string
 */
export function generateCronExpression(
  frequency: Exclude<ScheduleFrequency, "once">,
  time: string,
  day?: number,
): string {
  const [hourStr, minuteStr] = time.split(":");
  const hour = parseInt(hourStr ?? "0", 10);
  const minute = parseInt(minuteStr ?? "0", 10);

  switch (frequency) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${day ?? 1}`;
    case "monthly":
      return `${minute} ${hour} ${day ?? 1} * *`;
  }
}

/**
 * Detect system timezone using Intl API
 * @returns IANA timezone identifier (e.g., "America/New_York")
 */
export function detectTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Agent configuration within vm0.yaml
 */
interface AgentConfig {
  environment?: Record<string, string>;
}

/**
 * Result of extracting vars and secrets from vm0.yaml
 */
interface VarsAndSecrets {
  vars: string[];
  secrets: string[];
}

/**
 * Extract variable and secret names from vm0.yaml
 * Looks for ${{ vars.X }} and ${{ secrets.X }} patterns in environment
 */
export function extractVarsAndSecrets(): VarsAndSecrets {
  const result: VarsAndSecrets = { vars: [], secrets: [] };

  if (!existsSync(CONFIG_FILE)) {
    return result;
  }

  try {
    const content = readFileSync(CONFIG_FILE, "utf8");
    const config = parseYaml(content) as AgentComposeConfig;

    // Get first agent's config
    const agents = Object.values(config.agents || {}) as AgentConfig[];
    const agent = agents[0];
    if (!agent) {
      return result;
    }

    // Parse environment for ${{ vars.X }} and ${{ secrets.X }} patterns
    if (agent.environment) {
      for (const value of Object.values(agent.environment)) {
        // Match ${{ vars.NAME }}
        const varsMatches = value.matchAll(/\$\{\{\s*vars\.(\w+)\s*\}\}/g);
        for (const match of varsMatches) {
          if (match[1] && !result.vars.includes(match[1])) {
            result.vars.push(match[1]);
          }
        }

        // Match ${{ secrets.NAME }}
        const secretsMatches = value.matchAll(
          /\$\{\{\s*secrets\.(\w+)\s*\}\}/g,
        );
        for (const match of secretsMatches) {
          if (match[1] && !result.secrets.includes(match[1])) {
            result.secrets.push(match[1]);
          }
        }
      }
    }

    return result;
  } catch {
    return result;
  }
}

/**
 * Validate time format (HH:MM, 24-hour)
 * @param time - Time string to validate
 * @returns true if valid, error message if invalid
 */
export function validateTimeFormat(time: string): boolean | string {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return "Invalid format. Use HH:MM (e.g., 09:00)";
  }

  const hour = parseInt(match[1]!, 10);
  const minute = parseInt(match[2]!, 10);

  if (hour < 0 || hour > 23) {
    return "Hour must be 0-23";
  }
  if (minute < 0 || minute > 59) {
    return "Minute must be 0-59";
  }

  return true;
}

/**
 * Validate date format (YYYY-MM-DD)
 * @param date - Date string to validate
 * @returns true if valid, error message if invalid
 */
export function validateDateFormat(date: string): boolean | string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return "Invalid format. Use YYYY-MM-DD (e.g., 2025-01-15)";
  }

  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);

  if (year < 2000 || year > 2100) {
    return "Year must be between 2000 and 2100";
  }
  if (month < 1 || month > 12) {
    return "Month must be 1-12";
  }
  if (day < 1 || day > 31) {
    return "Day must be 1-31";
  }

  // Validate the date is actually valid (e.g., not Feb 30)
  const testDate = new Date(year, month - 1, day);
  if (
    testDate.getFullYear() !== year ||
    testDate.getMonth() !== month - 1 ||
    testDate.getDate() !== day
  ) {
    return "Invalid date";
  }

  return true;
}

/**
 * Get tomorrow's date in local timezone as YYYY-MM-DD
 * @returns Date string in YYYY-MM-DD format
 */
export function getTomorrowDateLocal(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const year = tomorrow.getFullYear();
  const month = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const day = String(tomorrow.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Get current time in local timezone as HH:MM
 * @returns Time string in HH:MM format
 */
export function getCurrentTimeLocal(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Convert a human-readable datetime string to ISO format
 * Supports formats: "YYYY-MM-DD HH:MM" or full ISO string
 * @param dateTimeStr - DateTime string (e.g., "2025-01-15 14:30")
 * @returns ISO format string (e.g., "2025-01-15T14:30:00.000Z")
 */
export function toISODateTime(dateTimeStr: string): string {
  // If already in ISO format, return as-is
  if (dateTimeStr.includes("T") && dateTimeStr.endsWith("Z")) {
    return dateTimeStr;
  }

  // Convert "YYYY-MM-DD HH:MM" to ISO
  const isoStr = dateTimeStr.replace(" ", "T") + ":00";
  const date = new Date(isoStr);
  return date.toISOString();
}

/**
 * Result of extracting required configuration from compose content
 */
export interface RequiredConfiguration {
  secrets: string[];
  vars: string[];
  credentials: string[];
}

/**
 * Extract required secrets, vars, and credentials from compose content.
 * Uses the same extraction logic as vm0 run command.
 * @param composeContent - The compose content from API (unknown type to handle various formats)
 * @returns Object with arrays of required secret, var, and credential names
 */
export function extractRequiredConfiguration(
  composeContent: unknown,
): RequiredConfiguration {
  const result: RequiredConfiguration = {
    secrets: [],
    vars: [],
    credentials: [],
  };

  if (!composeContent) {
    return result;
  }

  const refs = extractVariableReferences(composeContent);
  const grouped = groupVariablesBySource(refs);

  result.secrets = grouped.secrets.map((r) => r.name);
  result.vars = grouped.vars.map((r) => r.name);
  result.credentials = grouped.credentials.map((r) => r.name);

  return result;
}

/**
 * Result of resolving a schedule by name
 */
interface ResolveScheduleResult {
  name: string;
  composeId: string;
  composeName: string;
}

/**
 * Resolve a schedule by agent name using the list API.
 * Searches across all user's schedules and finds by composeName (agent name).
 * @throws Error if agent has no schedule
 */
export async function resolveScheduleByAgent(
  agentName: string,
): Promise<ResolveScheduleResult> {
  const { schedules } = await listSchedules();

  const schedule = schedules.find((s) => s.composeName === agentName);

  if (!schedule) {
    throw new Error(`No schedule found for agent "${agentName}"`);
  }

  return {
    name: schedule.name,
    composeId: schedule.composeId,
    composeName: schedule.composeName,
  };
}
