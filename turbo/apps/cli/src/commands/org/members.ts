import { Command } from "commander";
import chalk from "chalk";
import { getOrgMembers } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const membersCommand = new Command()
  .name("members")
  .description("View organization members")
  .action(
    withErrorHandler(async () => {
      try {
        const status = await getOrgMembers();

        console.log(chalk.bold(`Organization: ${status.slug}`));
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
          throw new Error("No active organization selected", {
            cause: new Error("Run: vm0 org use <slug>"),
          });
        }
        throw error;
      }
    }),
  );
