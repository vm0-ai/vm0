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

const DEFAULT_TIMEOUT_SECONDS = 60;

async function pollEvents(
  runId: string,
  timeoutSeconds: number,
): Promise<void> {
  let nextSequence = -1;
  let complete = false;
  const pollIntervalMs = 500;
  const timeoutMs = timeoutSeconds * 1000;
  const startTime = Date.now();

  while (!complete) {
    // Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      console.error(
        chalk.red(
          `\n✗ Agent execution timed out after ${timeoutSeconds} seconds without receiving events`,
        ),
      );
      throw new Error("Agent execution timed out");
    }

    const response = await apiClient.getEvents(runId, {
      since: nextSequence,
    });

    for (const event of response.events) {
      const parsed = ClaudeEventParser.parse(
        event.eventData as Record<string, unknown>,
      );

      if (parsed) {
        EventRenderer.render(parsed);

        // Complete when we receive vm0_result or vm0_error
        if (parsed.type === "vm0_result" || parsed.type === "vm0_error") {
          complete = true;
        }
      }
    }

    nextSequence = response.nextSequence;

    // If no new events and not complete, wait before next poll
    if (response.events.length === 0 && !complete) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

const runCmd = new Command()
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
  .option("--artifact-name <name>", "Artifact storage name (required for run)")
  .option(
    "--artifact-version <hash>",
    "Artifact version hash (defaults to latest)",
  )
  .option(
    "-t, --timeout <seconds>",
    "Polling timeout in seconds (default: 60)",
    String(DEFAULT_TIMEOUT_SECONDS),
  )
  .action(
    async (
      identifier: string,
      prompt: string,
      options: {
        env: Record<string, string>;
        artifactName?: string;
        artifactVersion?: string;
        timeout: string;
      },
    ) => {
      const timeoutSeconds = parseInt(options.timeout, 10);
      if (isNaN(timeoutSeconds) || timeoutSeconds <= 0) {
        console.error(
          chalk.red("✗ Invalid timeout value. Must be a positive number."),
        );
        process.exit(1);
      }

      // Validate artifact-name is provided for non-resume runs
      if (!options.artifactName) {
        console.error(
          chalk.red("✗ Missing required option: --artifact-name <name>"),
        );
        console.error(
          chalk.gray("  The artifact-name is required for new agent runs."),
        );
        process.exit(1);
      }

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

        console.log(chalk.gray(`  Artifact: ${options.artifactName}`));
        if (options.artifactVersion) {
          console.log(
            chalk.gray(`  Artifact version: ${options.artifactVersion}`),
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
          artifactName: options.artifactName,
          artifactVersion: options.artifactVersion,
        });

        // 4. Poll for events
        await pollEvents(response.runId, timeoutSeconds);
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

// Add resume subcommand
runCmd
  .command("resume")
  .description("Resume an agent run from a checkpoint")
  .argument("<checkpointId>", "Checkpoint ID to resume from")
  .argument("<prompt>", "Prompt for the resumed agent")
  .option(
    "-t, --timeout <seconds>",
    "Polling timeout in seconds (default: 60)",
    String(DEFAULT_TIMEOUT_SECONDS),
  )
  .action(
    async (
      checkpointId: string,
      prompt: string,
      options: { timeout: string },
    ) => {
      const timeoutSeconds = parseInt(options.timeout, 10);
      if (isNaN(timeoutSeconds) || timeoutSeconds <= 0) {
        console.error(
          chalk.red("✗ Invalid timeout value. Must be a positive number."),
        );
        process.exit(1);
      }
      try {
        // 1. Validate checkpoint ID format
        if (!isUUID(checkpointId)) {
          console.error(
            chalk.red(`✗ Invalid checkpoint ID format: ${checkpointId}`),
          );
          console.error(chalk.gray("  Checkpoint ID must be a valid UUID"));
          process.exit(1);
        }

        // 2. Display starting message
        console.log(chalk.blue("\nResuming agent run from checkpoint..."));
        console.log(chalk.gray(`  Checkpoint ID: ${checkpointId}`));
        console.log(chalk.gray(`  Prompt: ${prompt}`));
        console.log();
        console.log(chalk.blue("Executing in sandbox..."));
        console.log();

        // 3. Call resume API
        const response = await apiClient.resumeRun({
          checkpointId,
          prompt,
        });

        // 4. Poll for events
        await pollEvents(response.runId, timeoutSeconds);
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Not authenticated")) {
            console.error(
              chalk.red("✗ Not authenticated. Run: vm0 auth login"),
            );
          } else if (error.message.includes("not found")) {
            console.error(chalk.red(`✗ Checkpoint not found: ${checkpointId}`));
          } else {
            console.error(chalk.red("✗ Resume failed"));
            console.error(chalk.gray(`  ${error.message}`));
          }
        } else {
          console.error(chalk.red("✗ An unexpected error occurred"));
        }
        process.exit(1);
      }
    },
  );

export const runCommand = runCmd;
