import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { apiClient, type ApiError } from "../../lib/api-client";

const CONFIG_FILE = "vm0.yaml";

interface AgentComposeConfig {
  version: string;
  agents: Record<string, unknown>;
}

interface ScheduleResponse {
  id: string;
  name: string;
  composeName: string;
  scopeSlug: string;
  cronExpression: string | null;
  atTime: string | null;
  timezone: string;
  prompt: string;
  vars: Record<string, string> | null;
  secretNames: string[] | null;
  artifactName: string | null;
  artifactVersion: string | null;
  volumeVersions: Record<string, string> | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Load vm0.yaml and return agent name
 */
function loadAgentName(): string | null {
  if (!existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    const content = readFileSync(CONFIG_FILE, "utf8");
    const config = parseYaml(content) as AgentComposeConfig;
    const agentNames = Object.keys(config.agents || {});
    return agentNames[0] || null;
  } catch {
    return null;
  }
}

/**
 * Format date with relative time
 */
function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return chalk.dim("-");

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffAbs = Math.abs(diffMs);

  const minutes = Math.floor(diffAbs / (1000 * 60));
  const hours = Math.floor(diffAbs / (1000 * 60 * 60));
  const days = Math.floor(diffAbs / (1000 * 60 * 60 * 24));

  const isPast = diffMs < 0;
  let relative: string;

  if (days > 0) {
    relative = isPast ? `${days}d ago` : `in ${days}d`;
  } else if (hours > 0) {
    relative = isPast ? `${hours}h ago` : `in ${hours}h`;
  } else if (minutes > 0) {
    relative = isPast ? `${minutes}m ago` : `in ${minutes}m`;
  } else {
    relative = isPast ? "just now" : "soon";
  }

  const formatted = date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return `${formatted} ${chalk.dim(`(${relative})`)}`;
}

/**
 * Format trigger (cron or at)
 */
function formatTrigger(schedule: ScheduleResponse): string {
  if (schedule.cronExpression) {
    return `${schedule.cronExpression} ${chalk.dim(`(${schedule.timezone})`)}`;
  }
  if (schedule.atTime) {
    return `${schedule.atTime} ${chalk.dim("(one-time)")}`;
  }
  return chalk.dim("-");
}

export const statusCommand = new Command()
  .name("status")
  .description("Show detailed status of a schedule")
  .argument("<name>", "Schedule name")
  .action(async (name: string) => {
    try {
      // Load vm0.yaml to get agent name
      const agentName = loadAgentName();
      if (!agentName) {
        console.error(chalk.red("✗ No vm0.yaml found in current directory"));
        console.error(chalk.dim("  Run this command from the agent directory"));
        process.exit(1);
      }

      // Get compose ID
      let composeId: string;
      try {
        const compose = await apiClient.getComposeByName(agentName);
        composeId = compose.id;
      } catch {
        console.error(chalk.red(`✗ Agent not found: ${agentName}`));
        console.error(chalk.dim("  Make sure the agent is pushed first"));
        process.exit(1);
      }

      // Get schedule details
      const response = await apiClient.get(
        `/api/agent/schedules/${encodeURIComponent(name)}?composeId=${encodeURIComponent(composeId)}`,
      );

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        throw new Error(error.error?.message || "Failed to get schedule");
      }

      const schedule = (await response.json()) as ScheduleResponse;

      // Print header
      console.log();
      console.log(`Schedule: ${chalk.cyan(schedule.name)}`);
      console.log(chalk.dim("━".repeat(50)));

      // Status
      const statusText = schedule.enabled
        ? chalk.green("enabled")
        : chalk.yellow("disabled");
      console.log(`${"Status:".padEnd(16)}${statusText}`);

      // Agent
      console.log(`${"Agent:".padEnd(16)}${schedule.composeName} ${chalk.dim(`(${schedule.scopeSlug})`)}`);

      // Trigger
      console.log(`${"Trigger:".padEnd(16)}${formatTrigger(schedule)}`);

      // Next run (only if enabled)
      if (schedule.enabled) {
        console.log(`${"Next Run:".padEnd(16)}${formatDateTime(schedule.nextRunAt)}`);
      }

      // Last run
      if (schedule.lastRunAt) {
        const lastRunInfo = schedule.lastRunId
          ? `${formatDateTime(schedule.lastRunAt)} ${chalk.dim(`[${schedule.lastRunId.slice(0, 8)}]`)}`
          : formatDateTime(schedule.lastRunAt);
        console.log(`${"Last Run:".padEnd(16)}${lastRunInfo}`);
      }

      // Prompt (truncated)
      const promptPreview = schedule.prompt.length > 60
        ? schedule.prompt.slice(0, 57) + "..."
        : schedule.prompt;
      console.log(`${"Prompt:".padEnd(16)}${chalk.dim(promptPreview)}`);

      // Variables
      if (schedule.vars && Object.keys(schedule.vars).length > 0) {
        console.log(`${"Variables:".padEnd(16)}${Object.keys(schedule.vars).join(", ")}`);
      }

      // Secrets
      if (schedule.secretNames && schedule.secretNames.length > 0) {
        console.log(`${"Secrets:".padEnd(16)}${schedule.secretNames.join(", ")}`);
      }

      // Artifact
      if (schedule.artifactName) {
        const artifactInfo = schedule.artifactVersion
          ? `${schedule.artifactName}:${schedule.artifactVersion}`
          : schedule.artifactName;
        console.log(`${"Artifact:".padEnd(16)}${artifactInfo}`);
      }

      // Volume versions
      if (schedule.volumeVersions && Object.keys(schedule.volumeVersions).length > 0) {
        console.log(`${"Volumes:".padEnd(16)}${Object.keys(schedule.volumeVersions).join(", ")}`);
      }

      // Timestamps
      console.log();
      console.log(chalk.dim(`Created:  ${new Date(schedule.createdAt).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")}`));
      console.log(chalk.dim(`Updated:  ${new Date(schedule.updatedAt).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")}`));
      console.log(chalk.dim(`ID:       ${schedule.id}`));
      console.log();
    } catch (error) {
      console.error(chalk.red("✗ Failed to get schedule status"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else if (error.message.includes("not found") || error.message.includes("Not found")) {
          console.error(chalk.dim(`  Schedule "${name}" not found`));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
