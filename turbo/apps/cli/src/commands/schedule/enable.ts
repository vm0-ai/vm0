import { Command } from "commander";
import chalk from "chalk";
import { getComposeByName, enableSchedule } from "../../lib/api";
import {
  loadAgentName,
  loadScheduleName,
} from "../../lib/domain/schedule-utils";

export const enableCommand = new Command()
  .name("enable")
  .description("Enable a schedule")
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

      // Load vm0.yaml to get agent name
      const result = loadAgentName();
      if (result.error) {
        console.error(chalk.red(`✗ Invalid vm0.yaml: ${result.error}`));
        process.exit(1);
      }
      if (!result.agentName) {
        console.error(chalk.red("✗ No vm0.yaml found in current directory"));
        console.error(chalk.dim("  Run this command from the agent directory"));
        process.exit(1);
      }
      const agentName = result.agentName;

      // Get compose ID
      let composeId: string;
      try {
        const compose = await getComposeByName(agentName);
        composeId = compose.id;
      } catch {
        console.error(chalk.red(`✗ Agent not found: ${agentName}`));
        console.error(chalk.dim("  Make sure the agent is pushed first"));
        process.exit(1);
      }

      // Call API
      await enableSchedule({ name, composeId });

      console.log(chalk.green(`✓ Enabled schedule ${chalk.cyan(name)}`));
    } catch (error) {
      console.error(chalk.red("✗ Failed to enable schedule"));
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
