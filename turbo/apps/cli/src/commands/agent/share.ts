import { Command } from "commander";
import chalk from "chalk";
import { getComposeByName, httpPost, type ApiError } from "../../lib/api";

export const shareCommand = new Command()
  .name("share")
  .description("Share an agent with a user by email")
  .argument("<name>", "Agent name")
  .requiredOption("--email <email>", "Email address to share with")
  .action(async (name: string, options: { email: string }) => {
    try {
      // Resolve compose by name
      const compose = await getComposeByName(name);
      if (!compose) {
        console.error(chalk.red(`✗ Agent not found: ${name}`));
        process.exit(1);
      }

      // Add email permission
      const response = await httpPost(
        `/api/agent/composes/${compose.id}/permissions`,
        { granteeType: "email", granteeEmail: options.email },
      );

      if (!response.ok) {
        const error = (await response.json()) as ApiError;
        if (response.status === 409) {
          console.log(
            chalk.yellow(
              `Agent "${name}" is already shared with ${options.email}`,
            ),
          );
          return;
        }
        throw new Error(error.error?.message || "Failed to share agent");
      }

      console.log(
        chalk.green(`✓ Agent "${name}" shared with ${options.email}`),
      );
    } catch (error) {
      console.error(chalk.red("✗ Failed to share agent"));
      if (error instanceof Error) {
        console.error(chalk.dim(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
