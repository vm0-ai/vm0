import { Command } from "commander";
import chalk from "chalk";
import { getComposeByName, httpDelete, type ApiError } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const unshareCommand = new Command()
  .name("unshare")
  .description("Remove sharing from a user")
  .argument("<name>", "Agent name")
  .requiredOption("--email <email>", "Email address to unshare")
  .option(
    "--experimental-shared-agent",
    "Enable experimental agent sharing feature",
  )
  .action(
    withErrorHandler(
      async (
        name: string,
        options: { email: string; experimentalSharedAgent?: boolean },
      ) => {
        // Validate experimental flag
        if (!options.experimentalSharedAgent) {
          console.error(
            chalk.red(
              "✗ This command requires --experimental-shared-agent flag",
            ),
          );
          console.error();
          console.error(
            chalk.dim("  Agent sharing is an experimental feature."),
          );
          console.error();
          console.error("Example:");
          console.error(
            chalk.cyan(
              `  vm0 agent unshare ${name} --email ${options.email} --experimental-shared-agent`,
            ),
          );
          process.exit(1);
        }

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
              chalk.yellow(
                `Agent "${name}" is not shared with ${options.email}`,
              ),
            );
            return;
          }
          throw new Error(error.error?.message || "Failed to unshare agent");
        }

        console.log(
          chalk.green(`✓ Removed sharing of "${name}" from ${options.email}`),
        );
      },
    ),
  );
