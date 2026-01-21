import { Command } from "commander";
import chalk from "chalk";
import { listSchedules } from "../../lib/api";
import { formatRelativeTime } from "../../lib/domain/schedule-utils";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all schedules")
  .action(async () => {
    try {
      const result = await listSchedules();

      if (result.schedules.length === 0) {
        console.log(chalk.dim("No schedules found"));
        console.log(
          chalk.dim("  Create one with: vm0 schedule deploy schedule.yaml"),
        );
        return;
      }

      // Calculate column widths
      const nameWidth = Math.max(
        4,
        ...result.schedules.map((s) => s.name.length),
      );
      const agentWidth = Math.max(
        5,
        ...result.schedules.map((s) => s.composeName.length),
      );
      const triggerWidth = Math.max(
        7,
        ...result.schedules.map((s) =>
          s.cronExpression
            ? s.cronExpression.length + s.timezone.length + 3
            : s.atTime?.length || 0,
        ),
      );

      // Print header
      const header = [
        "NAME".padEnd(nameWidth),
        "AGENT".padEnd(agentWidth),
        "TRIGGER".padEnd(triggerWidth),
        "STATUS".padEnd(8),
        "NEXT RUN",
      ].join("  ");
      console.log(chalk.dim(header));

      // Print rows
      for (const schedule of result.schedules) {
        const trigger = schedule.cronExpression
          ? `${schedule.cronExpression} (${schedule.timezone})`
          : schedule.atTime || "-";

        const status = schedule.enabled
          ? chalk.green("enabled")
          : chalk.yellow("disabled");

        const nextRun = schedule.enabled
          ? formatRelativeTime(schedule.nextRunAt)
          : "-";

        const row = [
          schedule.name.padEnd(nameWidth),
          schedule.composeName.padEnd(agentWidth),
          trigger.padEnd(triggerWidth),
          status.padEnd(8 + (schedule.enabled ? 0 : 2)), // Account for chalk chars
          nextRun,
        ].join("  ");
        console.log(row);
      }
    } catch (error) {
      console.error(chalk.red("✗ Failed to list schedules"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
