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
          throw new Error(
            "This command requires --experimental-shared-agent flag",
            {
              cause: new Error(
                `Use: vm0 agent unshare ${name} --email ${options.email} --experimental-shared-agent`,
              ),
            },
          );
        }

        // Resolve compose by name
        const compose = await getComposeByName(name);
        if (!compose) {
          throw new Error(`Agent not found: ${name}`);
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
