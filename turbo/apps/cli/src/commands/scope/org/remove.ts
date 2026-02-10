import { Command } from "commander";
import chalk from "chalk";
import { removeOrgMember } from "../../../lib/api";

export const removeCommand = new Command()
  .name("remove")
  .description("Remove a member from your organization")
  .argument("<user-id>", "The user ID to remove")
  .action(async (userId: string) => {
    try {
      await removeOrgMember(userId);

      console.log(chalk.green(`✓ Member removed: ${userId}`));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else if (
          error.message.includes("not found") ||
          error.message.includes("404")
        ) {
          console.error(chalk.red("✗ Member not found in your organization."));
        } else if (
          error.message.includes("403") ||
          error.message.includes("not owner")
        ) {
          console.error(
            chalk.red("✗ Only organization owners can remove members."),
          );
        } else if (error.message.includes("cannot remove owner")) {
          console.error(chalk.red("✗ Cannot remove the organization owner."));
        } else {
          console.error(chalk.red(`✗ ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
