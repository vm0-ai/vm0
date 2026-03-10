import { Command } from "commander";
import chalk from "chalk";
import { getScope } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const statusCommand = new Command()
  .name("status")
  .description("View current scope status")
  .action(
    withErrorHandler(async () => {
      try {
        const scope = await getScope();

        console.log(chalk.bold("Scope Information:"));
        console.log(`  Slug: ${chalk.green(scope.slug)}`);
        console.log(
          `  Created: ${new Date(scope.createdAt).toLocaleDateString()}`,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("No scope configured")
        ) {
          console.log(chalk.yellow("No scope configured"));
          console.log();
          console.log("Set your scope with:");
          console.log(chalk.cyan("  vm0 scope set <slug>"));
          console.log();
          console.log("Example:");
          console.log(chalk.dim("  vm0 scope set myusername"));
          process.exit(1);
        }
        throw error;
      }
    }),
  );
