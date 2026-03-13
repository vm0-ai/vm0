import { Command } from "commander";
import chalk from "chalk";
import {
  getComposeByName,
  getOrg,
  httpPost,
  type ApiError,
} from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const publicCommand = new Command()
  .name("public")
  .description("Make an agent public (accessible to all authenticated users)")
  .argument("<name>", "Agent name")
  .option(
    "--experimental-shared-agent",
    "Enable experimental agent sharing feature",
  )
  .action(
    withErrorHandler(
      async (name: string, options: { experimentalSharedAgent?: boolean }) => {
        // Validate experimental flag
        if (!options.experimentalSharedAgent) {
          throw new Error(
            "This command requires --experimental-shared-agent flag",
            {
              cause: new Error(
                `Use: vm0 agent public ${name} --experimental-shared-agent`,
              ),
            },
          );
        }

        // Resolve compose by name
        const compose = await getComposeByName(name);
        if (!compose) {
          throw new Error(`Agent not found: ${name}`);
        }

        // Get org for display
        const org = await getOrg();

        // Add public permission
        const response = await httpPost(
          `/api/agent/composes/${compose.id}/permissions`,
          { granteeType: "public" },
        );

        if (!response.ok) {
          const error = (await response.json()) as ApiError;
          if (response.status === 409) {
            console.log(chalk.yellow(`Agent "${name}" is already public`));
            return;
          }
          throw new Error(
            error.error?.message || "Failed to make agent public",
          );
        }

        const fullName = `${org.slug}/${name}`;
        console.log(chalk.green(`✓ Agent "${name}" is now public`));
        console.log();
        console.log("Others can now run your agent with:");
        console.log(
          chalk.cyan(
            `  vm0 run ${fullName} --experimental-shared-agent "your prompt"`,
          ),
        );
      },
    ),
  );
