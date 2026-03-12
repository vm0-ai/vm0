import { Command } from "commander";
import chalk from "chalk";
import { getOrg } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const statusCommand = new Command()
  .name("status")
  .description("View current organization status")
  .action(
    withErrorHandler(async () => {
      try {
        const scope = await getOrg();

        console.log(chalk.bold("Organization Information:"));
        console.log(`  Slug: ${chalk.green(scope.slug)}`);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("No scope configured")
        ) {
          throw new Error("No organization configured", {
            cause: new Error("Set your organization with: vm0 org set <slug>"),
          });
        }
        throw error;
      }
    }),
  );
