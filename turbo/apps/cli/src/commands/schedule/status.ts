import { Command } from "commander";
import chalk from "chalk";
import { getScheduleByName, listScheduleRuns } from "../../lib/api";
import {
  formatDateTime,
  detectTimezone,
  resolveScheduleByAgent,
} from "../../lib/domain/schedule-utils";
import { withErrorHandler } from "../../lib/command";
import type { ScheduleResponse, RunSummary } from "@vm0/core";

type RunStatus = RunSummary["status"];

/**
 * Format date with styled relative time (adds chalk formatting)
 */
function formatDateTimeStyled(dateStr: string | null): string {
  if (!dateStr) return chalk.dim("-");
  const formatted = formatDateTime(dateStr);
  return formatted.replace(/\(([^)]+)\)$/, chalk.dim("($1)"));
}

/**
 * Format trigger (cron or at) - timezone shown separately
 */
function formatTrigger(schedule: ScheduleResponse): string {
  if (schedule.triggerType === "loop" && schedule.intervalSeconds !== null) {
    return `interval ${schedule.intervalSeconds}s ${chalk.dim("(loop)")}`;
  }
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
      return chalk.cyan(status);
    case "pending":
      return chalk.yellow(status);
    default:
      return status;
  }
}

/**
 * Print run configuration section
 */
function printRunConfiguration(schedule: ScheduleResponse): void {
  const statusText = schedule.enabled
    ? chalk.green("enabled")
    : chalk.yellow("disabled");
  console.log(`${"Status:".padEnd(16)}${statusText}`);

  console.log(
    `${"Agent:".padEnd(16)}${schedule.composeName} ${chalk.dim(`(${schedule.scopeSlug})`)}`,
  );

  const promptPreview =
    schedule.prompt.length > 60
      ? schedule.prompt.slice(0, 57) + "..."
      : schedule.prompt;
  console.log(`${"Prompt:".padEnd(16)}${chalk.dim(promptPreview)}`);

  if (schedule.vars && Object.keys(schedule.vars).length > 0) {
    console.log(
      `${"Variables:".padEnd(16)}${Object.keys(schedule.vars).join(", ")}`,
    );
  }

  if (schedule.secretNames && schedule.secretNames.length > 0) {
    console.log(`${"Secrets:".padEnd(16)}${schedule.secretNames.join(", ")}`);
  }

  if (schedule.artifactName) {
    const artifactInfo = schedule.artifactVersion
      ? `${schedule.artifactName}:${schedule.artifactVersion}`
      : schedule.artifactName;
    console.log(`${"Artifact:".padEnd(16)}${artifactInfo}`);
  }

  if (
    schedule.volumeVersions &&
    Object.keys(schedule.volumeVersions).length > 0
  ) {
    console.log(
      `${"Volumes:".padEnd(16)}${Object.keys(schedule.volumeVersions).join(", ")}`,
    );
  }
}

/**
 * Print time schedule section
 */
function printTimeSchedule(schedule: ScheduleResponse): void {
  console.log();
  console.log(`${"Trigger:".padEnd(16)}${formatTrigger(schedule)}`);
  console.log(`${"Timezone:".padEnd(16)}${detectTimezone()}`);

  if (schedule.enabled) {
    console.log(
      `${"Next Run:".padEnd(16)}${formatDateTimeStyled(schedule.nextRunAt)}`,
    );
  }

  if (schedule.triggerType === "loop") {
    const failureText =
      schedule.consecutiveFailures > 0
        ? chalk.yellow(`${schedule.consecutiveFailures}/3`)
        : chalk.dim("0/3");
    console.log(`${"Failures:".padEnd(16)}${failureText}`);
  }
}

/**
 * Print recent runs section
 */
async function printRecentRuns(
  name: string,
  composeId: string,
  limit: number,
): Promise<void> {
  if (limit <= 0) return;

  try {
    const { runs } = await listScheduleRuns({ name, composeId, limit });

    if (runs.length > 0) {
      console.log();
      console.log("Recent Runs:");
      console.log(
        chalk.dim("RUN ID                                STATUS     CREATED"),
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

export const statusCommand = new Command()
  .name("status")
  .description("Show detailed status of a schedule")
  .argument("<agent-name>", "Agent name")
  .option(
    "-n, --name <schedule-name>",
    "Schedule name (required when agent has multiple schedules)",
  )
  .option(
    "-l, --limit <number>",
    "Number of recent runs to show (0 to hide)",
    "5",
  )
  .action(
    withErrorHandler(
      async (agentName: string, options: { name?: string; limit: string }) => {
        const resolved = await resolveScheduleByAgent(agentName, options.name);
        const { name, composeId } = resolved;

        const schedule = await getScheduleByName({ name, composeId });

        console.log();
        console.log(`Schedule for agent: ${chalk.cyan(agentName)}`);
        console.log(chalk.dim("━".repeat(50)));

        printRunConfiguration(schedule);
        printTimeSchedule(schedule);

        const parsed = parseInt(options.limit, 10);
        const limit = Math.min(
          Math.max(0, Number.isNaN(parsed) ? 5 : parsed),
          100,
        );
        await printRecentRuns(name, composeId, limit);

        console.log();
      },
    ),
  );
