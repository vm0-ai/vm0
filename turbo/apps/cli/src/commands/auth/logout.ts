import { Command } from "commander";
import chalk from "chalk";
import { logout } from "../../lib/api/auth";

export const logoutCommand = new Command()
  .name("logout")
  .description("Log out of VM0")
  .action(async () => {
    try {
      await logout();
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
