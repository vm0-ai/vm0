import { Command } from "commander";
import chalk from "chalk";
import { getScopeMembers } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const membersCommand = new Command()
  .name("members")
  .description("View scope members")
  .action(
    withErrorHandler(async () => {
      try {
        const status = await getScopeMembers();

        console.log(chalk.bold(`Scope: ${status.slug}`));
        console.log(`  Role: ${status.role}`);
        console.log(
          `  Created: ${new Date(status.createdAt).toLocaleDateString()}`,
        );
        console.log();
        console.log(chalk.bold("Members:"));
        for (const member of status.members) {
          const roleTag =
            member.role === "admin"
              ? chalk.yellow(` (${member.role})`)
              : chalk.dim(` (${member.role})`);
          console.log(`  ${member.email}${roleTag}`);
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("Organization access token required")
        ) {
          console.error(
            chalk.red("✗ No active scope selected. Run: vm0 scope use <slug>"),
          );
          process.exit(1);
        }
        throw error;
      }
    }),
  );
