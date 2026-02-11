import { Command } from "commander";
import chalk from "chalk";
import { removeMember } from "../../../lib/api";

export const removeCommand = new Command()
  .name("remove")
  .description("Remove a member from the organization")
  .argument("<email>", "Email address of the member to remove")
  .action(async (email: string) => {
    try {
      await removeMember(email);
      console.log(chalk.green(`✓ Removed ${email} from organization`));
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`✗ ${error.message}`));
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
