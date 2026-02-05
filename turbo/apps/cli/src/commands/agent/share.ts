import { Command } from "commander";
import chalk from "chalk";
import {
  getComposeByName,
  getScope,
  httpPost,
  type ApiError,
} from "../../lib/api";

export const shareCommand = new Command()
  .name("experimental-share")
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

      // Get scope for display
      const scope = await getScope();

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

      const fullName = `${scope.slug}/${name}`;
      console.log(
        chalk.green(`✓ Agent "${name}" shared with ${options.email}`),
      );
      console.log();
      console.log("They can now run your agent with:");
      console.log(
        chalk.cyan(
          `  vm0 run ${fullName} --experimental-shared-agent "your prompt"`,
        ),
      );
    } catch (error) {
      console.error(chalk.red("✗ Failed to share agent"));
      if (error instanceof Error) {
        console.error(chalk.dim(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
