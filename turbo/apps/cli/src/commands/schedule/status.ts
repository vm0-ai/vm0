import { Command } from "commander";
import chalk from "chalk";
import { apiClient, type ApiError } from "../../lib/api/api-client";
import { loadAgentName, formatDateTime } from "../../lib/domain/schedule-utils";
import type {
  ScheduleResponse,
  RunSummary,
  ScheduleRunsResponse,
} from "@vm0/core";

// Re-export RunStatus type for local use (same as RunSummary['status'])
type RunStatus = RunSummary["status"];

/**
 * Format date with styled relative time (adds chalk formatting)
 */
function formatDateTimeStyled(dateStr: string | null): string {
  if (!dateStr) return chalk.dim("-");
  const formatted = formatDateTime(dateStr);
  // Add chalk.dim to the relative part (in parentheses)
  return formatted.replace(/\(([^)]+)\)$/, chalk.dim("($1)"));
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

/**
 * Format run status with color
 */
function formatRunStatus(status: RunStatus): string {
  switch (status) {
    case "completed":
      return chalk.green(status);
    case "failed":
    case "timeout":
      return chalk.red(status);
    case "running":
      return chalk.blue(status);
    case "pending":
      return chalk.yellow(status);
    default:
      return status;
  }
}

export const statusCommand = new Command()
  .name("status")
  .description("Show detailed status of a schedule")
  .argument("<name>", "Schedule name")
  .option(
    "-l, --limit <number>",
    "Number of recent runs to show (0 to hide)",
    "5",
  )
  .action(async (name: string, options: { limit: string }) => {
    try {
      // Load vm0.yaml to get agent name
      const result = loadAgentName();
      if (result.error) {
        console.error(chalk.red(`✗ Invalid vm0.yaml: ${result.error}`));
        process.exit(1);
      }
      if (!result.agentName) {
        console.error(chalk.red("✗ No vm0.yaml found in current directory"));
        console.error(chalk.dim("  Run this command from the agent directory"));
        process.exit(1);
      }
      const agentName = result.agentName;

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
      console.log(
        `${"Agent:".padEnd(16)}${schedule.composeName} ${chalk.dim(`(${schedule.scopeSlug})`)}`,
      );

      // Trigger
      console.log(`${"Trigger:".padEnd(16)}${formatTrigger(schedule)}`);

      // Next run (only if enabled)
      if (schedule.enabled) {
        console.log(
          `${"Next Run:".padEnd(16)}${formatDateTimeStyled(schedule.nextRunAt)}`,
        );
      }

      // Prompt (truncated)
      const promptPreview =
        schedule.prompt.length > 60
          ? schedule.prompt.slice(0, 57) + "..."
          : schedule.prompt;
      console.log(`${"Prompt:".padEnd(16)}${chalk.dim(promptPreview)}`);

      // Variables
      if (schedule.vars && Object.keys(schedule.vars).length > 0) {
        console.log(
          `${"Variables:".padEnd(16)}${Object.keys(schedule.vars).join(", ")}`,
        );
      }

      // Secrets
      if (schedule.secretNames && schedule.secretNames.length > 0) {
        console.log(
          `${"Secrets:".padEnd(16)}${schedule.secretNames.join(", ")}`,
        );
      }

      // Artifact
      if (schedule.artifactName) {
        const artifactInfo = schedule.artifactVersion
          ? `${schedule.artifactName}:${schedule.artifactVersion}`
          : schedule.artifactName;
        console.log(`${"Artifact:".padEnd(16)}${artifactInfo}`);
      }

      // Volume versions
      if (
        schedule.volumeVersions &&
        Object.keys(schedule.volumeVersions).length > 0
      ) {
        console.log(
          `${"Volumes:".padEnd(16)}${Object.keys(schedule.volumeVersions).join(", ")}`,
        );
      }

      // Fetch and display recent runs
      const limit = Math.min(
        Math.max(0, parseInt(options.limit, 10) || 5),
        100,
      );
      if (limit > 0) {
        const runsResponse = await apiClient.get(
          `/api/agent/schedules/${encodeURIComponent(name)}/runs?composeId=${encodeURIComponent(composeId)}&limit=${limit}`,
        );

        if (runsResponse.ok) {
          const { runs } = (await runsResponse.json()) as ScheduleRunsResponse;

          if (runs.length > 0) {
            console.log();
            console.log("Recent Runs:");
            for (const run of runs) {
              const id = chalk.dim(`[${run.id.slice(0, 8)}]`);
              const status = formatRunStatus(run.status).padEnd(20);
              const created = formatDateTimeStyled(run.createdAt);
              const errorMsg = run.error
                ? chalk.red(
                    run.error.length > 40
                      ? run.error.slice(0, 37) + "..."
                      : run.error,
                  )
                : "";
              console.log(`  ${id} ${status} ${created} ${errorMsg}`);
            }
          }
        } else {
          console.log();
          console.log(chalk.dim("Recent Runs: (unable to fetch)"));
        }
      }

      // Timestamps
      console.log();
      console.log(
        chalk.dim(
          `Created:  ${new Date(schedule.createdAt)
            .toISOString()
            .replace("T", " ")
            .replace(/\.\d+Z$/, " UTC")}`,
        ),
      );
      console.log(chalk.dim(`ID:       ${schedule.id}`));
      console.log();
    } catch (error) {
      console.error(chalk.red("✗ Failed to get schedule status"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else if (
          error.message.includes("not found") ||
          error.message.includes("Not found")
        ) {
          console.error(chalk.dim(`  Schedule "${name}" not found`));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
