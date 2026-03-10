import { Command } from "commander";
import chalk from "chalk";
import { inviteScopeMember } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const inviteCommand = new Command()
  .name("invite")
  .description("Invite a member to the current scope")
  .requiredOption("--email <email>", "Email address of the member to invite")
  .action(
    withErrorHandler(async (options: { email: string }) => {
      await inviteScopeMember(options.email);
      console.log(chalk.green(`✓ Invitation sent to ${options.email}`));
    }),
  );
