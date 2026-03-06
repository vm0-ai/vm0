import { Command } from "commander";
import chalk from "chalk";
import { removeScopeMember } from "../../lib/api";

export const removeCommand = new Command()
  .name("remove")
  .description("Remove a member from the current scope")
  .argument("<email>", "Email address of the member to remove")
  .action(async (email: string) => {
    try {
      await removeScopeMember(email);
      console.log(chalk.green(`✓ Removed ${email} from scope`));
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`✗ ${error.message}`));
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
