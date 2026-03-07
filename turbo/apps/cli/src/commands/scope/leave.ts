import { Command } from "commander";
import chalk from "chalk";
import { leaveScope } from "../../lib/api";
import { saveConfig } from "../../lib/api/config";

export const leaveCommand = new Command()
  .name("leave")
  .description("Leave the current scope")
  .action(async () => {
    try {
      await leaveScope();
      await saveConfig({ activeScope: undefined });
      console.log(chalk.green("✓ Left scope. Switched to default scope."));
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`✗ ${error.message}`));
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
