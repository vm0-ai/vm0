import { Command } from "commander";
import chalk from "chalk";
import { disableSchedule } from "../../lib/api";
import { resolveScheduleByAgent } from "../../lib/domain/schedule-utils";

export const disableCommand = new Command()
  .name("disable")
  .description("Disable a schedule")
  .argument("<agent-name>", "Agent name")
  .action(async (agentName: string) => {
    try {
      // Resolve schedule by agent name
      const resolved = await resolveScheduleByAgent(agentName);

      // Call API
      await disableSchedule({
        name: resolved.name,
        composeId: resolved.composeId,
      });

      console.log(
        chalk.green(`✓ Disabled schedule for agent ${chalk.cyan(agentName)}`),
      );
    } catch (error) {
      console.error(chalk.red("✗ Failed to disable schedule"));
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
