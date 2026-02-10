import { Command } from "commander";
import chalk from "chalk";
import { leaveOrg } from "../../../lib/api";
import {
  getScope as getConfigScope,
  clearScope,
} from "../../../lib/api/config";

export const leaveCommand = new Command()
  .name("leave")
  .description("Leave the current organization scope")
  .action(async () => {
    try {
      // Check current scope
      const currentScope = await getConfigScope();
      if (!currentScope) {
        console.error(
          chalk.yellow("You are not currently using an organization scope."),
        );
        console.error();
        console.error("To see available scopes:");
        console.error(chalk.cyan("  vm0 scope list"));
        process.exit(1);
      }

      await leaveOrg();

      // Clear the scope from config since we left
      await clearScope();

      console.log(chalk.green(`✓ Left organization: ${currentScope}`));
      console.log();
      console.log("Switched to personal scope.");
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else if (
          error.message.includes("not a member") ||
          error.message.includes("404")
        ) {
          console.error(
            chalk.red("✗ You are not a member of this organization."),
          );
        } else if (error.message.includes("owner cannot leave")) {
          console.error(
            chalk.red(
              "✗ Organization owners cannot leave. Transfer ownership first or delete the organization.",
            ),
          );
        } else {
          console.error(chalk.red(`✗ ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
