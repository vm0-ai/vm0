import { Command } from "commander";
import chalk from "chalk";
import { leaveOrg } from "../../../lib/api";
import { clearOrgToken } from "../../../lib/api/config";

export const leaveCommand = new Command()
  .name("leave")
  .description("Leave the current organization")
  .action(async () => {
    try {
      await leaveOrg();
      await clearOrgToken();
      console.log(
        chalk.green("✓ Left organization. Switched to personal scope."),
      );
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`✗ ${error.message}`));
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
