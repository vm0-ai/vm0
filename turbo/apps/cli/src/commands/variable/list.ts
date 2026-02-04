import { Command } from "commander";
import chalk from "chalk";
import { listVariables } from "../../lib/api";

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
  .action(async () => {
    try {
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
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
        } else {
          console.error(chalk.red(`✗ ${error.message}`));
        }
      } else {
        console.error(chalk.red("✗ An unexpected error occurred"));
      }
      process.exit(1);
    }
  });
