import { Command } from "commander";
import chalk from "chalk";
import {
  deleteZeroSchedule,
  resolveZeroScheduleByAgent,
} from "../../../lib/api";
import { isInteractive, promptConfirm } from "../../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a zero schedule")
  .argument("<agent-id>", "Agent ID")
  .option(
    "-n, --name <schedule-name>",
    "Schedule name (required when agent has multiple schedules)",
  )
  .option("-y, --yes", "Skip confirmation prompt")
  .action(
    withErrorHandler(
      async (agentName: string, options: { name?: string; yes?: boolean }) => {
        const resolved = await resolveZeroScheduleByAgent(
          agentName,
          options.name,
        );

        if (!options.yes) {
          if (!isInteractive()) {
            throw new Error("--yes flag is required in non-interactive mode");
          }
          const confirmed = await promptConfirm(
            `Delete schedule for agent ${chalk.cyan(agentName)}?`,
            false,
          );
          if (!confirmed) {
            console.log(chalk.dim("Cancelled"));
            return;
          }
        }

        await deleteZeroSchedule({
          name: resolved.name,
          agentId: resolved.agentId,
        });

        console.log(chalk.green(`✓ Schedule "${resolved.name}" deleted`));
      },
    ),
  );
