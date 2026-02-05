import { Command } from "commander";
import chalk from "chalk";
import { getComposeByName, httpDelete, type ApiError } from "../../lib/api";

export const privateCommand = new Command()
  .name("experimental-private")
  .description("Make an agent private (remove public access)")
  .argument("<name>", "Agent name")
  .action(async (name: string) => {
    try {
      // Resolve compose by name
      const compose = await getComposeByName(name);
      if (!compose) {
        console.error(chalk.red(`✗ Agent not found: ${name}`));
        process.exit(1);
      }

      // Remove public permission
      const response = await httpDelete(
        `/api/agent/composes/${compose.id}/permissions?type=public`,
      );

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        if (response.status === 404) {
          console.log(chalk.yellow(`Agent "${name}" is already private`));
          return;
        }
        throw new Error(error.error?.message || "Failed to make agent private");
      }

      console.log(chalk.green(`✓ Agent "${name}" is now private`));
    } catch (error) {
      console.error(chalk.red("✗ Failed to make agent private"));
      if (error instanceof Error) {
        console.error(chalk.dim(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
