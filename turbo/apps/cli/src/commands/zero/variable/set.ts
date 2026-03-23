import { Command } from "commander";
import chalk from "chalk";
import { setZeroVariable } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

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
          variable = await setZeroVariable({
            name,
            value,
            description: options.description,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("must contain only uppercase")
          ) {
            throw new Error(error.message, {
              cause: new Error(
                "Examples of valid variable names: MY_VAR, API_URL, DEBUG_MODE",
              ),
            });
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
