import { Command } from "commander";
import chalk from "chalk";
import { leaveScope } from "../../lib/api";
import { saveConfig } from "../../lib/api/config";
import { withErrorHandler } from "../../lib/command";

export const leaveCommand = new Command()
  .name("leave")
  .description("Leave the current scope")
  .action(
    withErrorHandler(async () => {
      await leaveScope();
      await saveConfig({ activeScope: undefined });
      console.log(chalk.green("✓ Left scope. Switched to default scope."));
    }),
  );
