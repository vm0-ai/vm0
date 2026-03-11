import { Command } from "commander";
import chalk from "chalk";
import { getComposeByName, httpDelete, type ApiError } from "../../lib/api";
import { withErrorHandler } from "../../lib/command";

export const privateCommand = new Command()
  .name("private")
  .description("Make an agent private (remove public access)")
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
                `Use: vm0 agent private ${name} --experimental-shared-agent`,
              ),
            },
          );
        }

        // Resolve compose by name
        const compose = await getComposeByName(name);
        if (!compose) {
          throw new Error(`Agent not found: ${name}`);
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
          throw new Error(
            error.error?.message || "Failed to make agent private",
          );
        }

        console.log(chalk.green(`✓ Agent "${name}" is now private`));
      },
    ),
  );
