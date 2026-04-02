import { Command } from "commander";
import chalk from "chalk";
import { inviteZeroOrgMember } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const inviteCommand = new Command()
  .name("invite")
  .description("Invite a member to the current organization")
  .requiredOption("--email <email>", "Email address of the member to invite")
  .option(
    "--role <role>",
    "Role for the invited member (member or admin)",
    "member",
  )
  .action(
    withErrorHandler(async (options: { email: string; role: string }) => {
      if (options.role !== "member" && options.role !== "admin") {
        throw new Error(
          `Invalid role "${options.role}". Must be "member" or "admin".`,
        );
      }
      await inviteZeroOrgMember(options.email, options.role);
      console.log(
        chalk.green(`✓ Invitation sent to ${options.email} as ${options.role}`),
      );
    }),
  );
