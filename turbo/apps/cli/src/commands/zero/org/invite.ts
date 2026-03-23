import { Command } from "commander";
import chalk from "chalk";
import { inviteZeroOrgMember } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const inviteCommand = new Command()
  .name("invite")
  .description("Invite a member to the current organization")
  .requiredOption("--email <email>", "Email address of the member to invite")
  .action(
    withErrorHandler(async (options: { email: string }) => {
      await inviteZeroOrgMember(options.email);
      console.log(chalk.green(`✓ Invitation sent to ${options.email}`));
    }),
  );
