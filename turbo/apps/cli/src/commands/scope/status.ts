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
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("No scope configured")
        ) {
          throw new Error("No scope configured", {
            cause: new Error("Set your scope with: vm0 scope set <slug>"),
          });
        }
        throw error;
      }
    }),
  );
