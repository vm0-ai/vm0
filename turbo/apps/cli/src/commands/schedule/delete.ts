import { Command } from "commander";
import chalk from "chalk";
import * as readline from "readline";
import { deleteSchedule } from "../../lib/api";
import {
  loadScheduleName,
  resolveScheduleByName,
} from "../../lib/domain/schedule-utils";

/**
 * Prompt for confirmation
 */
async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

export const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a schedule")
  .argument(
    "[name]",
    "Schedule name (auto-detected from schedule.yaml if omitted)",
  )
  .option("-f, --force", "Skip confirmation prompt")
  .action(async (nameArg: string | undefined, options: { force?: boolean }) => {
    // Auto-detect schedule name if not provided
    let name = nameArg;
    try {
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

      // Resolve schedule by name (searches globally across all agents)
      const resolved = await resolveScheduleByName(name);

      // Confirm deletion
      if (!options.force) {
        const confirmed = await confirm(`Delete schedule ${chalk.cyan(name)}?`);
        if (!confirmed) {
          console.log(chalk.dim("Cancelled"));
          return;
        }
      }

      // Call API
      await deleteSchedule({ name, composeId: resolved.composeId });

      console.log(chalk.green(`✓ Deleted schedule ${chalk.cyan(name)}`));
    } catch (error) {
      console.error(chalk.red("✗ Failed to delete schedule"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else if (error.message.toLowerCase().includes("not found")) {
          console.error(chalk.dim(`  Schedule "${name}" not found`));
          console.error(chalk.dim("  Run: vm0 schedule list"));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
