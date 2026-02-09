import { Command } from "commander";
import chalk from "chalk";
import { setupToken } from "../../lib/api/auth";

export const setupTokenCommand = new Command()
  .name("setup-token")
  .description("Output auth token for CI/CD environments")
  .action(async () => {
    try {
      await setupToken();
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
