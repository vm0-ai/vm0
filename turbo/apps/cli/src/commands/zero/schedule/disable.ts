import { Command } from "commander";
import chalk from "chalk";
import {
  disableZeroSchedule,
  resolveZeroScheduleByAgent,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const disableCommand = new Command()
  .name("disable")
  .description("Disable a zero schedule")
  .argument("<agent-id>", "Agent ID")
  .option(
    "-n, --name <schedule-name>",
    "Schedule name (required when agent has multiple schedules)",
  )
  .addHelpText(
    "after",
    `
Examples:
  zero schedule disable <agent-id>
  zero schedule disable <agent-id> -n my-schedule`,
  )
  .action(
    withErrorHandler(async (agentName: string, options: { name?: string }) => {
      const resolved = await resolveZeroScheduleByAgent(
        agentName,
        options.name,
      );

      await disableZeroSchedule({
        name: resolved.name,
        agentId: resolved.agentId,
      });

      console.log(chalk.green(`✓ Schedule "${resolved.name}" disabled`));
    }),
  );
