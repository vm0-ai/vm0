import { Command } from "commander";
import chalk from "chalk";
import { getComposeByName, httpDelete, type ApiError } from "../../lib/api";

export const unshareCommand = new Command()
  .name("experimental-unshare")
  .description("Remove sharing from a user")
  .argument("<name>", "Agent name")
  .requiredOption("--email <email>", "Email address to unshare")
  .action(async (name: string, options: { email: string }) => {
    try {
      // Resolve compose by name
      const compose = await getComposeByName(name);
      if (!compose) {
        console.error(chalk.red(`✗ Agent not found: ${name}`));
        process.exit(1);
      }

      // Remove email permission
      const response = await httpDelete(
        `/api/agent/composes/${compose.id}/permissions?type=email&email=${encodeURIComponent(options.email)}`,
      );

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        if (response.status === 404) {
          console.log(
            chalk.yellow(`Agent "${name}" is not shared with ${options.email}`),
          );
          return;
        }
        throw new Error(error.error?.message || "Failed to unshare agent");
      }

      console.log(
        chalk.green(`✓ Removed sharing of "${name}" from ${options.email}`),
      );
    } catch (error) {
      console.error(chalk.red("✗ Failed to unshare agent"));
      if (error instanceof Error) {
        console.error(chalk.dim(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
