import { Command } from "commander";
import chalk from "chalk";
import { createInviteLink } from "../../../lib/api";

export const inviteCommand = new Command()
  .name("invite")
  .description("Generate an invite link for your organization")
  .action(async () => {
    try {
      const invite = await createInviteLink();

      console.log(chalk.green("✓ Invite link created"));
      console.log();
      console.log("Share this link to invite members:");
      console.log(chalk.cyan(`  ${invite.url}`));
      console.log();
      console.log(
        chalk.dim(
          `This link expires on ${new Date(invite.expiresAt).toLocaleString()}`,
        ),
      );
      console.log(chalk.dim("The link can only be used once."));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else if (
          error.message.includes("not found") ||
          error.message.includes("404")
        ) {
          console.error(
            chalk.red("✗ You don't own an organization. Create one first:"),
          );
          console.error(chalk.cyan("  vm0 scope org create <slug>"));
        } else if (
          error.message.includes("403") ||
          error.message.includes("not owner")
        ) {
          console.error(
            chalk.red("✗ Only organization owners can create invite links."),
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
