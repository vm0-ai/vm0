import { Command } from "commander";
import chalk from "chalk";
import { deleteSchedule } from "../../lib/api";
import { resolveScheduleByAgent } from "../../lib/domain/schedule-utils";
import { isInteractive, promptConfirm } from "../../lib/utils/prompt-utils";

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a schedule")
  .argument("<agent-name>", "Agent name")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async (agentName: string, options: { force?: boolean }) => {
    try {
      // Resolve schedule by agent name
      const resolved = await resolveScheduleByAgent(agentName);

      // Confirm deletion
      if (!options.force) {
        if (!isInteractive()) {
          console.error(
            chalk.red("✗ --force required in non-interactive mode"),
          );
          process.exit(1);
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
      });

      console.log(
        chalk.green(`✓ Deleted schedule for agent ${chalk.cyan(agentName)}`),
      );
    } catch (error) {
      console.error(chalk.red("✗ Failed to delete schedule"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else if (
          error.message.toLowerCase().includes("not found") ||
          error.message.includes("No schedule found")
        ) {
          console.error(
            chalk.dim(`  No schedule found for agent "${agentName}"`),
          );
          console.error(chalk.dim("  Run: vm0 schedule list"));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
