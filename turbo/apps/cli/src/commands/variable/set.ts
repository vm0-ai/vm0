import { Command } from "commander";
import chalk from "chalk";
import { setVariable } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const setCommand = new Command()
  .name("set")
  .description("Create or update a variable")
  .argument("<name>", "Variable name (uppercase, e.g., MY_VAR)")
  .argument("<value>", "Variable value")
  .option("-d, --description <description>", "Optional description")
  .action(
    withErrorHandler(
      async (
        name: string,
        value: string,
        options: { description?: string },
      ) => {
        let variable;
        try {
          variable = await setVariable({
            name,
            value,
            description: options.description,
          });
        } catch (error) {
          // Provide helpful examples for naming validation errors
          if (
            error instanceof Error &&
            error.message.includes("must contain only uppercase")
          ) {
            console.error(chalk.red(`✗ ${error.message}`));
            console.error();
            console.error("Examples of valid variable names:");
            console.error(chalk.dim("  MY_VAR"));
            console.error(chalk.dim("  API_URL"));
            console.error(chalk.dim("  DEBUG_MODE"));
            process.exit(1);
          }
          throw error;
        }

        console.log(chalk.green(`✓ Variable "${variable.name}" saved`));
        console.log();
        console.log("Use in vm0.yaml:");
        console.log(chalk.cyan(`  environment:`));
        console.log(chalk.cyan(`    ${name}: \${{ vars.${name} }}`));
      },
    ),
  );
