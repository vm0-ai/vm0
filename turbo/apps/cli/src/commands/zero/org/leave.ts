import { Command } from "commander";
import chalk from "chalk";
import { leaveZeroOrg } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const leaveCommand = new Command()
  .name("leave")
  .description("Leave the current organization")
  .action(
    withErrorHandler(async () => {
      await leaveZeroOrg();
      console.log(chalk.green("✓ Left organization."));
    }),
  );
