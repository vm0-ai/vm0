import { Command } from "commander";
import chalk from "chalk";
import {
  getComposeByName,
  getScheduleByName,
  listScheduleRuns,
} from "../../lib/api";
import {
  loadAgentName,
  loadScheduleName,
  formatDateTime,
  detectTimezone,
} from "../../lib/domain/schedule-utils";
import type { ScheduleResponse, RunSummary } from "@vm0/core";

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
 * Format trigger (cron or at) - timezone shown separately
 */
function formatTrigger(schedule: ScheduleResponse): string {
  if (schedule.cronExpression) {
    return schedule.cronExpression;
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
  .argument(
    "[name]",
    "Schedule name (auto-detected from schedule.yaml if omitted)",
  )
  .option(
    "-l, --limit <number>",
    "Number of recent runs to show (0 to hide)",
    "5",
  )
  .action(async (nameArg: string | undefined, options: { limit: string }) => {
    try {
      // Auto-detect schedule name if not provided
      let name = nameArg;
      if (!name) {
        const scheduleResult = loadScheduleName();
        if (scheduleResult.error) {
          console.error(chalk.red(`✗ ${scheduleResult.error}`));
          process.exit(1);
        }
        if (!scheduleResult.scheduleName) {
          console.error(chalk.red("✗ Schedule name required"));
          console.error(
            chalk.dim(
              "  Provide name or run from directory with schedule.yaml",
            ),
          );
          process.exit(1);
        }
        name = scheduleResult.scheduleName;
      }

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
        const compose = await getComposeByName(agentName);
        composeId = compose.id;
      } catch {
        console.error(chalk.red(`✗ Agent not found: ${agentName}`));
        console.error(chalk.dim("  Make sure the agent is pushed first"));
        process.exit(1);
      }

      // Get schedule details
      const schedule = await getScheduleByName({ name, composeId });

      // Print header
      console.log();
      console.log(`Schedule: ${chalk.cyan(schedule.name)}`);
      console.log(chalk.dim("━".repeat(50)));

      // === Group 1: Run Configuration ===

      // Status
      const statusText = schedule.enabled
        ? chalk.green("enabled")
        : chalk.yellow("disabled");
      console.log(`${"Status:".padEnd(16)}${statusText}`);

      // Agent
      console.log(
        `${"Agent:".padEnd(16)}${schedule.composeName} ${chalk.dim(`(${schedule.scopeSlug})`)}`,
      );

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

      // === Group 2: Time Schedule ===
      console.log();

      // Trigger
      console.log(`${"Trigger:".padEnd(16)}${formatTrigger(schedule)}`);

      // Timezone
      console.log(`${"Timezone:".padEnd(16)}${detectTimezone()}`);

      // Next run (only if enabled)
      if (schedule.enabled) {
        console.log(
          `${"Next Run:".padEnd(16)}${formatDateTimeStyled(schedule.nextRunAt)}`,
        );
      }

      // === Group 3: Recent Runs ===
      const limit = Math.min(
        Math.max(0, parseInt(options.limit, 10) || 5),
        100,
      );
      if (limit > 0) {
        try {
          const { runs } = await listScheduleRuns({
            name,
            composeId,
            limit,
          });

          if (runs.length > 0) {
            console.log();
            console.log("Recent Runs:");
            console.log(
              chalk.dim(
                "RUN ID                                STATUS     CREATED",
              ),
            );
            for (const run of runs) {
              const id = run.id;
              const status = formatRunStatus(run.status).padEnd(10);
              const created = formatDateTimeStyled(run.createdAt);
              console.log(`${id}  ${status} ${created}`);
            }
          }
        } catch {
          console.log();
          console.log(chalk.dim("Recent Runs: (unable to fetch)"));
        }
      }
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
          console.error(
            chalk.dim(`  Schedule "${nameArg ?? "unknown"}" not found`),
          );
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
