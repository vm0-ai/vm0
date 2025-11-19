import { Command } from "commander";
import chalk from "chalk";
import { apiClient } from "../lib/api-client";
import { ClaudeEventParser } from "../lib/event-parser";
import { EventRenderer } from "../lib/event-renderer";

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

function isUUID(str: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(str);
}

async function pollEvents(runId: string): Promise<void> {
  let nextSequence = 0;
  let complete = false;
  const pollIntervalMs = 500;

  while (!complete) {
    try {
      const response = await apiClient.getEvents(runId, {
        since: nextSequence,
      });

      for (const event of response.events) {
        const parsed = ClaudeEventParser.parse(event.eventData);

        if (parsed) {
          EventRenderer.render(parsed);

          if (parsed.type === "result") {
            complete = true;
          }
        }
      }

      nextSequence = response.nextSequence;

      // If no new events and not complete, wait before next poll
      if (response.events.length === 0 && !complete) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } catch (error) {
      console.error(
        chalk.red("✗ Failed to poll events:"),
        error instanceof Error ? error.message : "Unknown error",
      );
      throw error;
    }
  }
}

export const runCommand = new Command()
  .name("run")
  .description("Execute an agent")
  .argument(
    "<identifier>",
    "Agent name or config ID (e.g., 'my-agent' or 'cfg-abc-123')",
  )
  .argument("<prompt>", "Prompt for the agent")
  .option(
    "-e, --env <key=value>",
    "Environment variables (repeatable)",
    collectEnvVars,
    {},
  )
  .action(
    async (
      identifier: string,
      prompt: string,
      options: { env: Record<string, string> },
    ) => {
      try {
        // 1. Resolve identifier to configId
        let configId: string;

        if (isUUID(identifier)) {
          // It's a UUID config ID - use directly
          configId = identifier;
          console.log(chalk.gray(`  Using config ID: ${configId}`));
        } else {
          // It's an agent name - resolve to config ID
          console.log(chalk.gray(`  Resolving agent name: ${identifier}`));
          try {
            const config = await apiClient.getConfigByName(identifier);
            configId = config.id;
            console.log(chalk.gray(`  Resolved to config ID: ${configId}`));
          } catch (error) {
            if (error instanceof Error) {
              console.error(chalk.red(`✗ Agent not found: ${identifier}`));
              console.error(
                chalk.gray(
                  "  Make sure you've built the agent with: vm0 build",
                ),
              );
            }
            process.exit(1);
          }
        }

        // 2. Display starting message
        console.log(chalk.blue("\nCreating agent run..."));
        console.log(chalk.gray(`  Prompt: ${prompt}`));

        if (Object.keys(options.env).length > 0) {
          console.log(
            chalk.gray(`  Variables: ${JSON.stringify(options.env)}`),
          );
        }

        console.log();
        console.log(chalk.blue("Executing in sandbox..."));
        console.log();

        // 3. Call API (async)
        const response = await apiClient.createRun({
          agentConfigId: configId,
          prompt,
          dynamicVars:
            Object.keys(options.env).length > 0 ? options.env : undefined,
        });

        // 4. Poll for events
        await pollEvents(response.runId);
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Not authenticated")) {
            console.error(
              chalk.red("✗ Not authenticated. Run: vm0 auth login"),
            );
          } else if (error.message.includes("not found")) {
            console.error(chalk.red(`✗ Agent not found: ${identifier}`));
            console.error(
              chalk.gray("  Make sure you've built the agent with: vm0 build"),
            );
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
