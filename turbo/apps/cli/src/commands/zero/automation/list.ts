import { Command } from "commander";
import chalk from "chalk";
import { listZeroAutomations } from "../../../lib/api";
import { formatRelativeTime } from "../../../lib/domain/schedule-utils";
import { withErrorHandler } from "../../../lib/command";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all zero automations")
  .addHelpText(
    "after",
    `
Examples:
  zero automation list`,
  )
  .action(
    withErrorHandler(async () => {
      const result = await listZeroAutomations();

      if (result.automations.length === 0) {
        console.log(chalk.dim("No automations found"));
        console.log(
          chalk.dim("  Create one with: zero automation setup <agent-id>"),
        );
        return;
      }

      const agentWidth = Math.max(
        5,
        ...result.automations.map((a) => {
          return a.agentId.length;
        }),
      );
      const automationWidth = Math.max(
        10,
        ...result.automations.map((a) => {
          return a.name.length;
        }),
      );
      const triggerWidth = Math.max(
        7,
        ...result.automations.map((a) => {
          return a.cronExpression
            ? a.cronExpression.length + a.timezone.length + 3
            : a.atTime?.length || 0;
        }),
      );

      const header = [
        "AGENT".padEnd(agentWidth),
        "AUTOMATION".padEnd(automationWidth),
        "TRIGGER".padEnd(triggerWidth),
        "STATUS".padEnd(8),
        "NEXT RUN",
      ].join("  ");
      console.log(chalk.dim(header));

      for (const automation of result.automations) {
        const trigger = automation.cronExpression
          ? `${automation.cronExpression} (${automation.timezone})`
          : automation.atTime || "-";

        const status = automation.enabled
          ? chalk.green("enabled")
          : chalk.yellow("disabled");

        const nextRun = automation.enabled
          ? formatRelativeTime(automation.nextRunAt)
          : "-";

        const row = [
          automation.agentId.padEnd(agentWidth),
          automation.name.padEnd(automationWidth),
          trigger.padEnd(triggerWidth),
          status.padEnd(8 + (automation.enabled ? 0 : 2)),
          nextRun,
        ].join("  ");
        console.log(row);
      }
    }),
  );
