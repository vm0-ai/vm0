import { Command } from "commander";
import chalk from "chalk";
import { listZeroSchedules } from "../../../lib/api";
import { formatRelativeTime } from "../../../lib/domain/schedule-utils";
import { withErrorHandler } from "../../../lib/command";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all zero schedules")
  .action(
    withErrorHandler(async () => {
      const result = await listZeroSchedules();

      if (result.schedules.length === 0) {
        console.log(chalk.dim("No schedules found"));
        console.log(
          chalk.dim("  Create one with: vm0 zero schedule setup <agent-name>"),
        );
        return;
      }

      const agentWidth = Math.max(
        5,
        ...result.schedules.map((s) => s.agentId.length),
      );
      const scheduleWidth = Math.max(
        8,
        ...result.schedules.map((s) => s.name.length),
      );
      const triggerWidth = Math.max(
        7,
        ...result.schedules.map((s) =>
          s.cronExpression
            ? s.cronExpression.length + s.timezone.length + 3
            : s.atTime?.length || 0,
        ),
      );

      const header = [
        "AGENT".padEnd(agentWidth),
        "SCHEDULE".padEnd(scheduleWidth),
        "TRIGGER".padEnd(triggerWidth),
        "STATUS".padEnd(8),
        "NEXT RUN",
      ].join("  ");
      console.log(chalk.dim(header));

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
          schedule.agentId.padEnd(agentWidth),
          schedule.name.padEnd(scheduleWidth),
          trigger.padEnd(triggerWidth),
          status.padEnd(8 + (schedule.enabled ? 0 : 2)),
          nextRun,
        ].join("  ");
        console.log(row);
      }
    }),
  );
