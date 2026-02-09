import { Command } from "commander";
import chalk from "chalk";
import { getComposeByName, httpDelete, type ApiError } from "../../lib/api";

export const privateCommand = new Command()
  .name("private")
  .description("Make an agent private (remove public access)")
  .argument("<name>", "Agent name")
  .option(
    "--experimental-shared-agent",
    "Enable experimental agent sharing feature",
  )
  .action(
    async (name: string, options: { experimentalSharedAgent?: boolean }) => {
      // Validate experimental flag
      if (!options.experimentalSharedAgent) {
        console.error(
          chalk.red("✗ This command requires --experimental-shared-agent flag"),
        );
        console.error();
        console.error(chalk.dim("  Agent sharing is an experimental feature."));
        console.error();
        console.error("Example:");
        console.error(
          chalk.cyan(`  vm0 agent private ${name} --experimental-shared-agent`),
        );
        process.exit(1);
      }

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
          throw new Error(
            error.error?.message || "Failed to make agent private",
          );
        }

        console.log(chalk.green(`✓ Agent "${name}" is now private`));
      } catch (error) {
        console.error(chalk.red("✗ Failed to make agent private"));
        if (error instanceof Error) {
          console.error(chalk.dim(`  ${error.message}`));
        }
        process.exit(1);
      }
    },
  );
