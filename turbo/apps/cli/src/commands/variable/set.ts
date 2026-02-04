import { Command } from "commander";
import chalk from "chalk";
import { setVariable } from "../../lib/api";

export const setCommand = new Command()
  .name("set")
  .description("Create or update a variable")
  .argument("<name>", "Variable name (uppercase, e.g., MY_VAR)")
  .argument("<value>", "Variable value")
  .option("-d, --description <description>", "Optional description")
  .action(
    async (name: string, value: string, options: { description?: string }) => {
      try {
        const variable = await setVariable({
          name,
          value,
          description: options.description,
        });

        console.log(chalk.green(`✓ Variable "${variable.name}" saved`));
        console.log();
        console.log("Use in vm0.yaml:");
        console.log(chalk.cyan(`  environment:`));
        console.log(chalk.cyan(`    ${name}: \${{ vars.${name} }}`));
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Not authenticated")) {
            console.error(
              chalk.red("✗ Not authenticated. Run: vm0 auth login"),
            );
          } else if (error.message.includes("must contain only uppercase")) {
            console.error(chalk.red(`✗ ${error.message}`));
            console.log();
            console.log("Examples of valid variable names:");
            console.log(chalk.dim("  MY_VAR"));
            console.log(chalk.dim("  API_URL"));
            console.log(chalk.dim("  DEBUG_MODE"));
          } else {
            console.error(chalk.red(`✗ ${error.message}`));
          }
        } else {
          console.error(chalk.red("✗ An unexpected error occurred"));
        }
        process.exit(1);
      }
    },
  );
