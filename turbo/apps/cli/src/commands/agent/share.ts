import { Command } from "commander";
import chalk from "chalk";
import {
  getComposeByName,
  getOrg,
  httpPost,
  type ApiError,
} from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const shareCommand = new Command()
  .name("share")
  .description("Share an agent with a user by email")
  .argument("<name>", "Agent name")
  .requiredOption("--email <email>", "Email address to share with")
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
                `Use: vm0 agent share ${name} --email ${options.email} --experimental-shared-agent`,
              ),
            },
          );
        }

        // Resolve compose by name
        const compose = await getComposeByName(name);
        if (!compose) {
          throw new Error(`Agent not found: ${name}`);
        }

        // Get scope for display
        const scope = await getOrg();

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
      },
    ),
  );
