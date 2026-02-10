import { Command } from "commander";
import chalk from "chalk";
import { getOrgStatus } from "../../../lib/api";

export const statusCommand = new Command()
  .name("status")
  .description("View organization status and members")
  .action(async () => {
    try {
      const status = await getOrgStatus();

      console.log(chalk.bold("Organization Information:"));
      console.log(`  Slug: ${chalk.green(status.slug)}`);
      console.log(`  Member Count: ${status.memberCount}`);
      console.log(
        `  Created: ${new Date(status.createdAt).toLocaleDateString()}`,
      );

      if (status.members.length > 0) {
        console.log();
        console.log(chalk.bold("Members:"));
        for (const member of status.members) {
          const roleTag =
            member.role === "owner"
              ? chalk.yellow("(owner)")
              : chalk.dim("(member)");
          const email = member.email ? ` <${member.email}>` : "";
          console.log(`  - ${member.userId}${email} ${roleTag}`);
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else if (
          error.message.includes("not found") ||
          error.message.includes("404")
        ) {
          console.log(chalk.yellow("You don't own an organization yet."));
          console.log();
          console.log("To create one:");
          console.log(chalk.cyan("  vm0 scope org create <slug>"));
        } else {
          console.error(chalk.red(`✗ ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
