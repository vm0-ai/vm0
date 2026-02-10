import { Command } from "commander";
import chalk from "chalk";
import { listVariables } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

/**
 * Truncate value for display if too long
 */
function truncateValue(value: string, maxLength: number = 60): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength - 15) + "... [truncated]";
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List all variables")
  .action(
    withErrorHandler(async () => {
      const result = await listVariables();

      if (result.variables.length === 0) {
        console.log(chalk.dim("No variables found"));
        console.log();
        console.log("To add a variable:");
        console.log(chalk.cyan("  vm0 variable set MY_VAR <value>"));
        return;
      }

      console.log(chalk.bold("Variables:"));
      console.log();

      for (const variable of result.variables) {
        const displayValue = truncateValue(variable.value);
        console.log(`  ${chalk.cyan(variable.name)} = ${displayValue}`);
        if (variable.description) {
          console.log(`    ${chalk.dim(variable.description)}`);
        }
        console.log(
          `    ${chalk.dim(`Updated: ${new Date(variable.updatedAt).toLocaleString()}`)}`,
        );
        console.log();
      }

      console.log(chalk.dim(`Total: ${result.variables.length} variable(s)`));
    }),
  );
