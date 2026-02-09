import { Command } from "commander";
import chalk from "chalk";
import { checkAuthStatus } from "../../lib/api/auth";

export const statusCommand = new Command()
  .name("status")
  .description("Show current authentication status")
  .action(async () => {
    try {
      await checkAuthStatus();
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`✗ ${error.message}`));
        if (error.cause instanceof Error) {
          console.error(chalk.dim(`  Cause: ${error.cause.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
