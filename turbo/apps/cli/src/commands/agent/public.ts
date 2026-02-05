import { Command } from "commander";
import chalk from "chalk";
import {
  getComposeByName,
  getScope,
  httpPost,
  type ApiError,
} from "../../lib/api";

export const publicCommand = new Command()
  .name("experimental-public")
  .description("Make an agent public (accessible to all authenticated users)")
  .argument("<name>", "Agent name")
  .action(async (name: string) => {
    try {
      // Resolve compose by name
      const compose = await getComposeByName(name);
      if (!compose) {
        console.error(chalk.red(`✗ Agent not found: ${name}`));
        process.exit(1);
      }

      // Get scope for display
      const scope = await getScope();

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
        throw new Error(error.error?.message || "Failed to make agent public");
      }

      const fullName = `${scope.slug}/${name}`;
      console.log(chalk.green(`✓ Agent "${name}" is now public`));
      console.log();
      console.log("Others can now run your agent with:");
      console.log(
        chalk.cyan(
          `  vm0 run ${fullName} --experimental-shared-agent "your prompt"`,
        ),
      );
    } catch (error) {
      console.error(chalk.red("✗ Failed to make agent public"));
      if (error instanceof Error) {
        console.error(chalk.dim(`  ${error.message}`));
      }
      process.exit(1);
    }
  });
