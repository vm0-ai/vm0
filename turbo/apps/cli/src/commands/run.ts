import { Command } from "commander";
import chalk from "chalk";
import { apiClient } from "../lib/api-client";
import { ClaudeEventParser } from "../lib/event-parser";
import { EventRenderer } from "../lib/event-renderer";

function collectVars(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const [key, ...valueParts] = value.split("=");
  const val = valueParts.join("="); // Support values with '='

  if (!key || val === undefined || val === "") {
    throw new Error(`Invalid variable format: ${value} (expected key=value)`);
  }

  return { ...previous, [key]: val };
}

/**
 * Collector for --volume-version flags
 * Format: volumeName=version
 */
function collectVolumeVersions(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const [volumeName, ...versionParts] = value.split("=");
  const version = versionParts.join("=");

  if (!volumeName || version === undefined || version === "") {
    throw new Error(
      `Invalid volume-version format: ${value} (expected volumeName=version)`,
    );
  }

  return { ...previous, [volumeName]: version };
}

function isUUID(str: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(str);
}

const DEFAULT_TIMEOUT_SECONDS = 120;

interface PollOptions {
  verbose?: boolean;
}

/**
 * Poll for events until vm0_result or vm0_error is received
 * @returns true if run succeeded (vm0_result), false if run failed (vm0_error)
 */
async function pollEvents(
  runId: string,
  timeoutSeconds: number,
  options?: PollOptions,
): Promise<boolean> {
  let nextSequence = -1;
  let complete = false;
  let runSucceeded = true;
  const pollIntervalMs = 500;
  const timeoutMs = timeoutSeconds * 1000;
  const startTime = Date.now();
  const startTimestamp = new Date();
  let previousTimestamp = startTimestamp;
  const verbose = options?.verbose;

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
        EventRenderer.render(parsed, {
          verbose,
          previousTimestamp,
          startTimestamp,
        });

        // Update previous timestamp for next event
        previousTimestamp = parsed.timestamp;

        // Complete when we receive vm0_result or vm0_error
        if (parsed.type === "vm0_result") {
          complete = true;
          runSucceeded = true;
        } else if (parsed.type === "vm0_error") {
          complete = true;
          runSucceeded = false;
        }
      }
    }

    nextSequence = response.nextSequence;

    // If no new events and not complete, wait before next poll
    if (response.events.length === 0 && !complete) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return runSucceeded;
}

/**
 * Log verbose pre-flight messages
 */
function logVerbosePreFlight(
  action: string,
  details: Array<{ label: string; value: string | undefined }>,
): void {
  console.log(chalk.blue(`\n${action}...`));
  for (const { label, value } of details) {
    if (value !== undefined) {
      console.log(chalk.gray(`  ${label}: ${value}`));
    }
  }
  console.log();
  console.log(chalk.blue("Executing in sandbox..."));
  console.log();
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
    "--vars <KEY=value>",
    "Template variables for config placeholders (repeatable)",
    collectVars,
    {},
  )
  .option("--artifact-name <name>", "Artifact storage name (required for run)")
  .option(
    "--artifact-version <hash>",
    "Artifact version hash (defaults to latest)",
  )
  .option(
    "--volume-version <name=version>",
    "Volume version override (repeatable, format: volumeName=version)",
    collectVolumeVersions,
    {},
  )
  .option(
    "--conversation <id>",
    "Resume from conversation ID (for fine-grained control)",
  )
  .option(
    "-t, --timeout <seconds>",
    "Polling timeout in seconds (default: 120)",
    String(DEFAULT_TIMEOUT_SECONDS),
  )
  .option("-v, --verbose", "Show verbose output with timing information")
  .action(
    async (
      identifier: string,
      prompt: string,
      options: {
        vars: Record<string, string>;
        artifactName?: string;
        artifactVersion?: string;
        volumeVersion: Record<string, string>;
        conversation?: string;
        timeout: string;
        verbose?: boolean;
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

      const verbose = options.verbose;

      try {
        // 1. Resolve identifier to composeId
        let composeId: string;

        if (isUUID(identifier)) {
          // It's a UUID compose ID - use directly
          composeId = identifier;
          if (verbose) {
            console.log(chalk.gray(`  Using compose ID: ${composeId}`));
          }
        } else {
          // It's an agent name - resolve to compose ID
          if (verbose) {
            console.log(chalk.gray(`  Resolving agent name: ${identifier}`));
          }
          try {
            const compose = await apiClient.getComposeByName(identifier);
            composeId = compose.id;
            if (verbose) {
              console.log(chalk.gray(`  Resolved to compose ID: ${composeId}`));
            }
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

        // 2. Display starting message (verbose only)
        if (verbose) {
          logVerbosePreFlight("Creating agent run", [
            { label: "Prompt", value: prompt },
            {
              label: "Variables",
              value:
                Object.keys(options.vars).length > 0
                  ? JSON.stringify(options.vars)
                  : undefined,
            },
            { label: "Artifact", value: options.artifactName },
            { label: "Artifact version", value: options.artifactVersion },
            {
              label: "Volume versions",
              value:
                Object.keys(options.volumeVersion).length > 0
                  ? JSON.stringify(options.volumeVersion)
                  : undefined,
            },
            { label: "Conversation", value: options.conversation },
          ]);
        }

        // 3. Call unified API
        const response = await apiClient.createRun({
          agentComposeId: composeId,
          prompt,
          templateVars:
            Object.keys(options.vars).length > 0 ? options.vars : undefined,
          artifactName: options.artifactName,
          artifactVersion: options.artifactVersion,
          volumeVersions:
            Object.keys(options.volumeVersion).length > 0
              ? options.volumeVersion
              : undefined,
          conversationId: options.conversation,
        });

        // 4. Poll for events and exit with appropriate code
        const succeeded = await pollEvents(response.runId, timeoutSeconds, {
          verbose,
        });
        if (!succeeded) {
          process.exit(1);
        }
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

// Add resume subcommand (alias for --checkpoint)
runCmd
  .command("resume")
  .description("Resume an agent run from a checkpoint (uses all snapshot data)")
  .argument("<checkpointId>", "Checkpoint ID to resume from")
  .argument("<prompt>", "Prompt for the resumed agent")
  .option(
    "--volume-version <name=version>",
    "Volume version override (repeatable)",
    collectVolumeVersions,
    {},
  )
  .option(
    "-t, --timeout <seconds>",
    "Polling timeout in seconds (default: 120)",
    String(DEFAULT_TIMEOUT_SECONDS),
  )
  .option("-v, --verbose", "Show verbose output with timing information")
  .action(
    async (
      checkpointId: string,
      prompt: string,
      options: { timeout: string; verbose?: boolean },
      command: { optsWithGlobals: () => Record<string, unknown> },
    ) => {
      // Commander.js quirk: when parent command has same option name,
      // the option value goes to parent. Use optsWithGlobals() to get all options.
      const allOpts = command.optsWithGlobals() as {
        volumeVersion: Record<string, string>;
        timeout: string;
        verbose?: boolean;
      };
      const timeoutSeconds = parseInt(options.timeout, 10);
      if (isNaN(timeoutSeconds) || timeoutSeconds <= 0) {
        console.error(
          chalk.red("✗ Invalid timeout value. Must be a positive number."),
        );
        process.exit(1);
      }

      const verbose = options.verbose || allOpts.verbose;

      try {
        // 1. Validate checkpoint ID format
        if (!isUUID(checkpointId)) {
          console.error(
            chalk.red(`✗ Invalid checkpoint ID format: ${checkpointId}`),
          );
          console.error(chalk.gray("  Checkpoint ID must be a valid UUID"));
          process.exit(1);
        }

        // 2. Display starting message (verbose only)
        if (verbose) {
          logVerbosePreFlight("Resuming agent run from checkpoint", [
            { label: "Checkpoint ID", value: checkpointId },
            { label: "Prompt", value: prompt },
            {
              label: "Volume overrides",
              value:
                Object.keys(allOpts.volumeVersion).length > 0
                  ? JSON.stringify(allOpts.volumeVersion)
                  : undefined,
            },
          ]);
        }

        // 3. Call unified API with checkpointId
        const response = await apiClient.createRun({
          checkpointId,
          prompt,
          volumeVersions:
            Object.keys(allOpts.volumeVersion).length > 0
              ? allOpts.volumeVersion
              : undefined,
        });

        // 4. Poll for events and exit with appropriate code
        const succeeded = await pollEvents(response.runId, timeoutSeconds, {
          verbose,
        });
        if (!succeeded) {
          process.exit(1);
        }
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

// Add continue subcommand (alias for --session)
runCmd
  .command("continue")
  .description(
    "Continue an agent run from a session (uses latest artifact version)",
  )
  .argument("<agentSessionId>", "Agent session ID to continue from")
  .argument("<prompt>", "Prompt for the continued agent")
  .option(
    "--volume-version <name=version>",
    "Volume version override (repeatable)",
    collectVolumeVersions,
    {},
  )
  .option(
    "-t, --timeout <seconds>",
    "Polling timeout in seconds (default: 120)",
    String(DEFAULT_TIMEOUT_SECONDS),
  )
  .option("-v, --verbose", "Show verbose output with timing information")
  .action(
    async (
      agentSessionId: string,
      prompt: string,
      options: { timeout: string; verbose?: boolean },
      command: { optsWithGlobals: () => Record<string, unknown> },
    ) => {
      // Commander.js quirk: when parent command has same option name,
      // the option value goes to parent. Use optsWithGlobals() to get all options.
      const allOpts = command.optsWithGlobals() as {
        volumeVersion: Record<string, string>;
        timeout: string;
        verbose?: boolean;
      };
      const timeoutSeconds = parseInt(options.timeout, 10);
      if (isNaN(timeoutSeconds) || timeoutSeconds <= 0) {
        console.error(
          chalk.red("✗ Invalid timeout value. Must be a positive number."),
        );
        process.exit(1);
      }

      const verbose = options.verbose || allOpts.verbose;

      try {
        // 1. Validate session ID format
        if (!isUUID(agentSessionId)) {
          console.error(
            chalk.red(`✗ Invalid agent session ID format: ${agentSessionId}`),
          );
          console.error(chalk.gray("  Agent session ID must be a valid UUID"));
          process.exit(1);
        }

        // 2. Display starting message (verbose only)
        if (verbose) {
          logVerbosePreFlight("Continuing agent run from session", [
            { label: "Session ID", value: agentSessionId },
            { label: "Prompt", value: prompt },
            { label: "Note", value: "Using latest artifact version" },
            {
              label: "Volume overrides",
              value:
                Object.keys(allOpts.volumeVersion).length > 0
                  ? JSON.stringify(allOpts.volumeVersion)
                  : undefined,
            },
          ]);
        }

        // 3. Call unified API with sessionId
        const response = await apiClient.createRun({
          sessionId: agentSessionId,
          prompt,
          volumeVersions:
            Object.keys(allOpts.volumeVersion).length > 0
              ? allOpts.volumeVersion
              : undefined,
        });

        // 4. Poll for events and exit with appropriate code
        const succeeded = await pollEvents(response.runId, timeoutSeconds, {
          verbose,
        });
        if (!succeeded) {
          process.exit(1);
        }
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Not authenticated")) {
            console.error(
              chalk.red("✗ Not authenticated. Run: vm0 auth login"),
            );
          } else if (error.message.includes("not found")) {
            console.error(
              chalk.red(`✗ Agent session not found: ${agentSessionId}`),
            );
          } else {
            console.error(chalk.red("✗ Continue failed"));
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
