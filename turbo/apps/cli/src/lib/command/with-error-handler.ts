import chalk from "chalk";
import { RUN_ERROR_GUIDANCE } from "@vm0/core/contracts/errors";
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
          if (process.env.ZERO_TOKEN) {
            console.error(chalk.red("✗ Authentication failed"));
            console.error(chalk.dim("  ZERO_TOKEN is invalid or expired"));
          } else {
            console.error(chalk.red("✗ Not authenticated"));
            console.error(chalk.dim("  Run: vm0 auth login"));
          }
        } else {
          const guidance = RUN_ERROR_GUIDANCE[error.code];
          if (guidance) {
            console.error(chalk.red(`✗ ${guidance.title}`));
            console.error(chalk.dim(`  ${guidance.guidance}`));
            if (guidance.cliHint) {
              console.error(chalk.dim(`  Run: ${guidance.cliHint}`));
            }
          } else {
            console.error(chalk.red(`✗ ${error.status}: ${error.message}`));
          }
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
