import { Command } from "commander";
import chalk from "chalk";
import { apiClient } from "../lib/api-client";

function collectEnvVars(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const [key, ...valueParts] = value.split("=");
  const val = valueParts.join("="); // Support values with '='

  if (!key || val === undefined || val === "") {
    throw new Error(`Invalid env var format: ${value} (expected key=value)`);
  }

  return { ...previous, [key]: val };
}

export const runCommand = new Command()
  .name("run")
  .description("Execute an agent")
  .argument("<configId>", "Config ID (e.g., cfg-abc-123)")
  .argument("<prompt>", "Prompt for the agent")
  .option(
    "-e, --env <key=value>",
    "Environment variables (repeatable)",
    collectEnvVars,
    {},
  )
  .action(
    async (
      configId: string,
      prompt: string,
      options: { env: Record<string, string> },
    ) => {
      try {
        // 1. Validate configId format
        if (
          !configId.startsWith("cfg-") &&
          !/^[0-9a-f-]{36}$/i.test(configId)
        ) {
          console.error(chalk.red(`✗ Invalid config ID format: ${configId}`));
          console.error(
            chalk.gray("  Config ID should be a UUID or start with 'cfg-'"),
          );
          process.exit(1);
        }

        // 2. Display starting message
        console.log(chalk.blue("Creating agent run..."));
        console.log(chalk.gray(`  Config: ${configId}`));
        console.log(chalk.gray(`  Prompt: ${prompt}`));

        if (Object.keys(options.env).length > 0) {
          console.log(
            chalk.gray(`  Variables: ${JSON.stringify(options.env)}`),
          );
        }

        console.log();
        console.log(chalk.blue("Executing in sandbox..."));

        // 3. Call API (synchronous)
        const startTime = Date.now();
        const response = await apiClient.createRun({
          agentConfigId: configId,
          prompt,
          dynamicVars:
            Object.keys(options.env).length > 0 ? options.env : undefined,
        });

        const duration = Math.round((Date.now() - startTime) / 1000);

        // 4. Display result
        console.log();
        console.log(chalk.green(`✓ Run completed: ${response.runId}`));
        console.log();

        if (response.output) {
          console.log("Output:");
          console.log(response.output);
          console.log();
        }

        if (response.error) {
          console.log(chalk.red("Error:"));
          console.log(response.error);
          console.log();
        }

        console.log(chalk.gray(`Execution time: ${duration}s`));
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Not authenticated")) {
            console.error(
              chalk.red("✗ Not authenticated. Run: vm0 auth login"),
            );
          } else if (error.message.includes("not found")) {
            console.error(chalk.red("✗ Config not found: " + configId));
          } else {
            console.error(chalk.red("✗ Run failed"));
            console.error(chalk.gray(`  ${error.message}`));
          }
        } else {
          console.error(chalk.red("✗ An unexpected error occurred"));
        }
        process.exit(1);
      }
    },
  );
