import { Command } from "commander";
import chalk from "chalk";
import { leaveOrg } from "../../lib/api";
import { saveConfig } from "../../lib/api/config";
import { withErrorHandler } from "../../lib/command";

export const leaveCommand = new Command()
  .name("leave")
  .description("Leave the current organization")
  .action(
    withErrorHandler(async () => {
      await leaveOrg();
      await saveConfig({ activeOrg: undefined });
      console.log(
        chalk.green("✓ Left organization. Switched to personal org."),
      );
    }),
  );
