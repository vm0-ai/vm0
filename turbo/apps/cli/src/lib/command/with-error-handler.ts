import chalk from "chalk";
import { ApiRequestError } from "../api/core/client-factory";

/**
 * Wraps a Commander.js action handler with centralized error handling.
 *
 * Catches errors thrown by the action, formats them consistently,
 * and calls process.exit(1). Commands with specific error handling
 * should use an inner try/catch and re-throw for generic handling.
 */
export function withErrorHandler<T extends unknown[]>(
  fn: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.code === "UNAUTHORIZED") {
          console.error(chalk.red("✗ Not authenticated"));
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else {
          console.error(chalk.red(`✗ ${error.status}: ${error.message}`));
        }
      } else if (error instanceof Error) {
        console.error(chalk.red(`✗ ${error.message}`));
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }

      if (error instanceof Error && error.cause instanceof Error) {
        console.error(chalk.dim(`  Cause: ${error.cause.message}`));
      }

      process.exit(1);
    }
  };
}
