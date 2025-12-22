import { Command } from "commander";
import chalk from "chalk";
import { apiClient } from "../../lib/api-client";

export const statusCommand = new Command()
  .name("status")
  .description("View current scope status")
  .action(async () => {
    try {
      const scope = await apiClient.getScope();

      console.log(chalk.cyan("Scope Information:"));
      console.log(`  Slug: ${chalk.green(scope.slug)}`);
      console.log(`  Type: ${scope.type}`);
      if (scope.displayName) {
        console.log(`  Display Name: ${scope.displayName}`);
      }
      console.log(
        `  Created: ${new Date(scope.createdAt).toLocaleDateString()}`,
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else if (error.message.includes("No scope configured")) {
          console.log(chalk.yellow("No scope configured."));
          console.log();
          console.log("Set your scope with:");
          console.log(chalk.cyan("  vm0 scope set <slug>"));
          console.log();
          console.log("Example:");
          console.log(chalk.gray("  vm0 scope set myusername"));
        } else {
          console.error(chalk.red(`✗ ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
