import { Command } from "commander";
import chalk from "chalk";
import { deleteSchedule } from "../../lib/api";
import { resolveScheduleByAgent } from "../../lib/domain/schedule-utils";
import { isInteractive, promptConfirm } from "../../lib/utils/prompt-utils";
import { withErrorHandler } from "../../lib/command";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a schedule")
  .argument("<agent-name>", "Agent name")
  .option(
    "-n, --name <schedule-name>",
    "Schedule name (required when agent has multiple schedules)",
  )
  .option("-y, --yes", "Skip confirmation prompt")
  .action(
    withErrorHandler(
      async (agentName: string, options: { name?: string; yes?: boolean }) => {
        // Resolve schedule by agent name
        const resolved = await resolveScheduleByAgent(agentName, options.name);

        // Confirm deletion
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

        // Call API
        await deleteSchedule({
          name: resolved.name,
          composeId: resolved.composeId,
          scopeId: resolved.scopeId,
        });

        console.log(
          chalk.green(`✓ Deleted schedule for agent ${chalk.cyan(agentName)}`),
        );
      },
    ),
  );
