import { Command } from "commander";
import chalk from "chalk";
import { leaveZeroOrg } from "../../../lib/api/domains/zero-orgs";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

export const leaveCommand = new Command()
  .name("leave")
  .description("Leave the current organization")
  .action(
    withErrorHandler(async () => {
      await leaveZeroOrg();
      console.log(chalk.green("✓ Left organization."));
    }),
  );
