import { Command } from "commander";
import chalk from "chalk";
import { resolveZeroScheduleByAgent } from "../../../lib/api";
import {
  formatDateTime,
  detectTimezone,
} from "../../../lib/domain/schedule-utils";
import { withErrorHandler } from "../../../lib/command";
import type { ScheduleResponse } from "@vm0/core";

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
 * Print run configuration section
 */
function printRunConfiguration(
  schedule: ScheduleResponse,
  showFullPrompt: boolean,
): void {
  const statusText = schedule.enabled
    ? chalk.green("enabled")
    : chalk.yellow("disabled");
  console.log(`${"Status:".padEnd(16)}${statusText}`);

  console.log(`${"Agent:".padEnd(16)}${schedule.agentId}`);

  if (showFullPrompt) {
    console.log(`${"Prompt:".padEnd(16)}${chalk.dim(schedule.prompt)}`);
  } else {
    const promptPreview =
      schedule.prompt.length > 60
        ? schedule.prompt.slice(0, 57) + "..."
        : schedule.prompt;
    console.log(`${"Prompt:".padEnd(16)}${chalk.dim(promptPreview)}`);
  }

  if (schedule.vars && Object.keys(schedule.vars).length > 0) {
    console.log(
      `${"Variables:".padEnd(16)}${Object.keys(schedule.vars).join(", ")}`,
    );
  }

  if (schedule.secretNames && schedule.secretNames.length > 0) {
    console.log(`${"Secrets:".padEnd(16)}${schedule.secretNames.join(", ")}`);
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

  if (schedule.triggerType === "loop" || schedule.triggerType === "cron") {
    const failureText =
      schedule.consecutiveFailures > 0
        ? chalk.yellow(`${schedule.consecutiveFailures}/3`)
        : chalk.dim("0/3");
    console.log(`${"Failures:".padEnd(16)}${failureText}`);
  }
}

export const statusCommand = new Command()
  .name("status")
  .description("Show detailed status of a zero schedule")
  .argument("<agent-id>", "Agent ID")
  .option(
    "-n, --name <schedule-name>",
    "Schedule name (required when agent has multiple schedules)",
  )
  .option("-p, --prompt", "Show full prompt content without truncation")
  .addHelpText(
    "after",
    `
Examples:
  zero schedule status <agent-id>
  zero schedule status <agent-id> -n my-schedule
  zero schedule status <agent-id> --prompt`,
  )
  .action(
    withErrorHandler(
      async (
        agentName: string,
        options: { name?: string; prompt?: boolean },
      ) => {
        const schedule = await resolveZeroScheduleByAgent(
          agentName,
          options.name,
        );

        console.log();
        console.log(`Schedule for agent: ${chalk.cyan(agentName)}`);
        console.log(chalk.dim("━".repeat(50)));

        printRunConfiguration(schedule, options.prompt ?? false);
        printTimeSchedule(schedule);

        console.log();
      },
    ),
  );
