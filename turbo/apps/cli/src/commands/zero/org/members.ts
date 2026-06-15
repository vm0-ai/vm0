import { Command } from "commander";
import chalk from "chalk";
import { getZeroOrgMembers } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const membersCommand = new Command()
  .name("members")
  .description("View organization members")
  .action(
    withErrorHandler(async () => {
      const status = await getZeroOrgMembers();

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
    }),
  );
