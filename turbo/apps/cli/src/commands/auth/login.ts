import { Command } from "commander";
import chalk from "chalk";
import { authenticate } from "../../lib/api/auth";

export const loginCommand = new Command()
  .name("login")
  .description("Log in to VM0 (use VM0_API_URL env var to set API URL)")
  .action(async () => {
    try {
      await authenticate();
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`✗ Login failed`));
        console.error(chalk.dim(`  ${error.message}`));
        if (error.cause instanceof Error) {
          console.error(chalk.dim(`  Cause: ${error.cause.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
