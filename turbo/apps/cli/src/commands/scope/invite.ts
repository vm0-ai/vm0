import { Command } from "commander";
import chalk from "chalk";
import { inviteMember } from "../../lib/api";

export const inviteCommand = new Command()
  .name("invite")
  .description("Invite a member to the current scope")
  .requiredOption("--email <email>", "Email address of the member to invite")
  .action(async (options: { email: string }) => {
    try {
      await inviteMember(options.email);
      console.log(chalk.green(`✓ Invitation sent to ${options.email}`));
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`✗ ${error.message}`));
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
