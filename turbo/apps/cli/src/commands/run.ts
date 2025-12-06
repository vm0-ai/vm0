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

/**
 * Parse identifier with optional version specifier
 * Format: name:version or just name
 * Examples: "demo:d084948d", "demo:latest", "demo"
 */
function parseIdentifier(identifier: string): {
  name: string;
  version?: string;
} {
  // UUIDs don't contain colons, so check first
  if (isUUID(identifier)) {
    return { name: identifier };
  }

  // Parse name:version format using lastIndexOf to handle edge cases
  const colonIndex = identifier.lastIndexOf(":");
  if (colonIndex > 0 && colonIndex < identifier.length - 1) {
    return {
      name: identifier.slice(0, colonIndex),
      version: identifier.slice(colonIndex + 1),
    };
  }

  return { name: identifier };
}

interface PollOptions {
  verbose?: boolean;
  startTimestamp: Date;
}

interface PollResult {
  succeeded: boolean;
  sessionId?: string;
  checkpointId?: string;
}

/**
 * Poll for events until vm0_result or vm0_error is received
 * @returns Poll result with success status and optional session/checkpoint IDs
 */
async function pollEvents(
  runId: string,
  options: PollOptions,
): Promise<PollResult> {
  let nextSequence = -1;
  let complete = false;
  let result: PollResult = { succeeded: true };
  const pollIntervalMs = 500;
  const startTimestamp = options.startTimestamp;
  let previousTimestamp = startTimestamp;
  const verbose = options.verbose;

  while (!complete) {
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
          result = {
            succeeded: true,
            sessionId: parsed.data.agentSessionId as string | undefined,
            checkpointId: parsed.data.checkpointId as string | undefined,
          };
        } else if (parsed.type === "vm0_error") {
          complete = true;
          result = { succeeded: false };
        }
      }
    }

    nextSequence = response.nextSequence;

    // If no new events and not complete, check sandbox status and wait
    if (response.events.length === 0 && !complete) {
      // Check if sandbox was terminated unexpectedly
      if (response.status === "failed" || response.status === "timeout") {
        console.error(
          chalk.red(
            `\n✗ Sandbox terminated unexpectedly (status: ${response.status})`,
          ),
        );
        throw new Error(`Sandbox terminated: ${response.status}`);
      }

      // Edge case: run completed but no result event received
      if (response.status === "completed") {
        console.error(
          chalk.yellow(
            "\n⚠ Run completed but no result event received. This may indicate an issue.",
          ),
        );
        return { succeeded: false };
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return result;
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

/**
 * Display next steps after successful run
 */
function showNextSteps(result: PollResult): void {
  const { sessionId, checkpointId } = result;

  if (sessionId || checkpointId) {
    console.log();
    console.log("Next steps:");
    if (sessionId) {
      console.log("  Continue with session (latest state):");
      console.log(
        chalk.cyan(`    vm0 run continue ${sessionId} "your next prompt"`),
      );
    }
    if (checkpointId) {
      console.log("  Resume from checkpoint (exact snapshot state):");
      console.log(
        chalk.cyan(`    vm0 run resume ${checkpointId} "your next prompt"`),
      );
    }
  }
}

const runCmd = new Command()
  .name("run")
  .description("Execute an agent")
  .argument(
    "<identifier>",
    "Agent name, config ID, or name:version (e.g., 'my-agent', 'my-agent:abc123', 'my-agent:latest')",
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
        verbose?: boolean;
      },
    ) => {
      const startTimestamp = new Date(); // Capture command start time for elapsed calculation

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
        // 1. Parse identifier for optional version specifier
        const { name, version } = parseIdentifier(identifier);

        // 2. Resolve name to composeId
        let composeId: string;

        if (isUUID(name)) {
          // It's a UUID compose ID - use directly
          composeId = name;
          if (verbose) {
            console.log(chalk.gray(`  Using compose ID: ${identifier}`));
          }
        } else {
          // It's an agent name - resolve to compose ID
          if (verbose) {
            console.log(chalk.gray(`  Resolving agent name: ${name}`));
          }
          try {
            const compose = await apiClient.getComposeByName(name);
            composeId = compose.id;
            if (verbose) {
              console.log(chalk.gray(`  Resolved to compose ID: ${composeId}`));
            }
          } catch (error) {
            if (error instanceof Error) {
              console.error(chalk.red(`✗ Agent not found: ${name}`));
              console.error(
                chalk.gray(
                  "  Make sure you've built the agent with: vm0 build",
                ),
              );
            }
            process.exit(1);
          }
        }

        // 3. Resolve version if specified
        let agentComposeVersionId: string | undefined;

        if (version && version !== "latest") {
          // Resolve version hash to full version ID
          if (verbose) {
            console.log(chalk.gray(`  Resolving version: ${version}`));
          }
          try {
            const versionInfo = await apiClient.getComposeVersion(
              composeId,
              version,
            );
            agentComposeVersionId = versionInfo.versionId;
            if (verbose) {
              console.log(
                chalk.gray(
                  `  Resolved to version ID: ${agentComposeVersionId.slice(0, 8)}...`,
                ),
              );
            }
          } catch (error) {
            if (error instanceof Error) {
              console.error(chalk.red(`✗ Version not found: ${version}`));
              console.error(
                chalk.gray(
                  "  Make sure the version hash exists. Use 'vm0 build' to see available versions.",
                ),
              );
            }
            process.exit(1);
          }
        }
        // Note: "latest" version uses agentComposeId which resolves to HEAD

        // 4. Display starting message (verbose only)
        if (verbose) {
          logVerbosePreFlight("Creating agent run", [
            { label: "Prompt", value: prompt },
            { label: "Version", value: version || "latest (HEAD)" },
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

        // 3. Call unified API (server handles all variable expansion)
        const response = await apiClient.createRun({
          // Use agentComposeVersionId if resolved, otherwise use agentComposeId (resolves to HEAD)
          ...(agentComposeVersionId
            ? { agentComposeVersionId }
            : { agentComposeId: composeId }),
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
        const result = await pollEvents(response.runId, {
          verbose,
          startTimestamp,
        });
        if (!result.succeeded) {
          process.exit(1);
        }
        showNextSteps(result);
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
  .option("-v, --verbose", "Show verbose output with timing information")
  .action(
    async (
      checkpointId: string,
      prompt: string,
      options: { verbose?: boolean },
      command: { optsWithGlobals: () => Record<string, unknown> },
    ) => {
      const startTimestamp = new Date(); // Capture command start time for elapsed calculation

      // Commander.js quirk: when parent command has same option name,
      // the option value goes to parent. Use optsWithGlobals() to get all options.
      const allOpts = command.optsWithGlobals() as {
        volumeVersion: Record<string, string>;
        verbose?: boolean;
      };

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
        const result = await pollEvents(response.runId, {
          verbose,
          startTimestamp,
        });
        if (!result.succeeded) {
          process.exit(1);
        }
        showNextSteps(result);
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
  .option("-v, --verbose", "Show verbose output with timing information")
  .action(
    async (
      agentSessionId: string,
      prompt: string,
      options: { verbose?: boolean },
      command: { optsWithGlobals: () => Record<string, unknown> },
    ) => {
      const startTimestamp = new Date(); // Capture command start time for elapsed calculation

      // Commander.js quirk: when parent command has same option name,
      // the option value goes to parent. Use optsWithGlobals() to get all options.
      const allOpts = command.optsWithGlobals() as {
        volumeVersion: Record<string, string>;
        verbose?: boolean;
      };

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
        const result = await pollEvents(response.runId, {
          verbose,
          startTimestamp,
        });
        if (!result.succeeded) {
          process.exit(1);
        }
        showNextSteps(result);
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
