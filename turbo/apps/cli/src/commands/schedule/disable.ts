import { Command } from "commander";
import chalk from "chalk";
import { disableSchedule } from "../../lib/api";
import {
  loadScheduleName,
  resolveScheduleByName,
} from "../../lib/domain/schedule-utils";

export const disableCommand = new Command()
  .name("disable")
  .description("Disable a schedule")
  .argument(
    "[name]",
    "Schedule name (auto-detected from schedule.yaml if omitted)",
  )
  .action(async (nameArg: string | undefined) => {
    try {
      // Auto-detect schedule name if not provided
      let name = nameArg;
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

      // Call API
      await disableSchedule({ name, composeId: resolved.composeId });

      console.log(chalk.green(`✓ Disabled schedule ${chalk.cyan(name)}`));
    } catch (error) {
      console.error(chalk.red("✗ Failed to disable schedule"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else if (error.message.toLowerCase().includes("not found")) {
          console.error(chalk.dim(`  Schedule "${nameArg}" not found`));
          console.error(chalk.dim("  Run: vm0 schedule list"));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
