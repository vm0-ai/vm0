import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { config as dotenvConfig } from "dotenv";
import { apiClient } from "../lib/api-client";
import { parseEvent } from "../lib/event-parser-factory";
import { EventRenderer } from "../lib/event-renderer";
import { CodexEventRenderer } from "../lib/codex-event-renderer";
import { extractVariableReferences, groupVariablesBySource } from "@vm0/core";

/**
 * Collector for --secrets and --vars flags
 * Format: KEY=value
 */
function collectKeyValue(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const [key, ...valueParts] = value.split("=");
  const val = valueParts.join("="); // Support values with '='

  if (!key || val === undefined || val === "") {
    throw new Error(`Invalid format: ${value} (expected KEY=value)`);
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
 * Extract var names from compose config
 */
function extractVarNames(composeContent: unknown): string[] {
  const refs = extractVariableReferences(composeContent);
  const grouped = groupVariablesBySource(refs);
  return grouped.vars.map((r) => r.name);
}

/**
 * Extract secret names from compose config
 */
function extractSecretNames(composeContent: unknown): string[] {
  const refs = extractVariableReferences(composeContent);
  const grouped = groupVariablesBySource(refs);
  return grouped.secrets.map((r) => r.name);
}

/**
 * Load values with priority: CLI args > environment variables > .env file
 *
 * For values referenced in the compose config but not provided via CLI,
 * falls back to environment variables and .env file.
 * CLI-provided values are always passed through.
 *
 * @param cliValues Values passed via CLI flags
 * @param configNames Names referenced in compose config (for env fallback)
 * @returns Merged values object with CLI taking highest priority
 */
function loadValues(
  cliValues: Record<string, string>,
  configNames: string[],
): Record<string, string> | undefined {
  // Start with CLI-provided values (highest priority, always passed through)
  const result: Record<string, string> = { ...cliValues };

  // For names referenced in config but not provided via CLI, load from env/.env
  const missingNames = configNames.filter((name) => !(name in result));

  if (missingNames.length > 0) {
    // Load .env file if it exists (lowest priority)
    const envFilePath = path.resolve(process.cwd(), ".env");
    let dotenvValues: Record<string, string> = {};

    if (fs.existsSync(envFilePath)) {
      const dotenvResult = dotenvConfig({ path: envFilePath });
      if (dotenvResult.parsed) {
        // Only include keys that are missing
        dotenvValues = Object.fromEntries(
          Object.entries(dotenvResult.parsed).filter(([key]) =>
            missingNames.includes(key),
          ),
        );
      }
    }

    // Get from environment variables (medium priority)
    const envValues: Record<string, string> = {};
    for (const name of missingNames) {
      const envValue = process.env[name];
      if (envValue !== undefined) {
        envValues[name] = envValue;
      }
    }

    // Merge with priority: env > .env (CLI already in result)
    Object.assign(result, dotenvValues, envValues);
  }

  return Object.keys(result).length > 0 ? result : undefined;
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
  runId: string;
  sessionId?: string;
  checkpointId?: string;
}

/**
 * Poll for events until run completes (via run.status field)
 * @returns Poll result with success status and optional session/checkpoint IDs
 */
async function pollEvents(
  runId: string,
  options: PollOptions,
): Promise<PollResult> {
  let nextSequence = 0;
  let complete = false;
  let result: PollResult = { succeeded: true, runId };
  const pollIntervalMs = 500;
  const startTimestamp = options.startTimestamp;
  let previousTimestamp = startTimestamp;
  const verbose = options.verbose;

  while (!complete) {
    const response = await apiClient.getEvents(runId, {
      since: nextSequence,
    });

    // Render agent events (use appropriate renderer based on provider from API)
    for (const event of response.events) {
      const eventData = event.eventData as Record<string, unknown>;

      if (response.provider === "codex") {
        // Use Codex renderer for Codex provider
        CodexEventRenderer.render(eventData);
      } else {
        // Use Claude Code renderer (default)
        const parsed = parseEvent(eventData);
        if (parsed) {
          EventRenderer.render(parsed, {
            verbose,
            previousTimestamp,
            startTimestamp,
          });
          previousTimestamp = parsed.timestamp;
        }
      }
    }

    nextSequence = response.nextSequence;

    // Check run status for completion (replaces vm0_result/vm0_error events)
    const runStatus = response.run.status;

    if (runStatus === "completed") {
      complete = true;
      // Render completion info
      EventRenderer.renderRunCompleted(response.run.result, {
        verbose,
        previousTimestamp,
        startTimestamp,
      });
      result = {
        succeeded: true,
        runId,
        sessionId: response.run.result?.agentSessionId,
        checkpointId: response.run.result?.checkpointId,
      };
    } else if (runStatus === "failed") {
      complete = true;
      // Render error info
      EventRenderer.renderRunFailed(response.run.error, runId);
      result = { succeeded: false, runId };
    } else if (runStatus === "timeout") {
      complete = true;
      console.error(chalk.red("\n✗ Run timed out"));
      console.error(
        chalk.gray(`  (use "vm0 logs ${runId} --system" to view system logs)`),
      );
      result = { succeeded: false, runId };
    }

    // If not complete, wait before next poll
    if (!complete) {
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
  const { runId, sessionId, checkpointId } = result;

  console.log();
  console.log("Next steps:");

  // Always show logs command since we always have runId
  console.log("  View telemetry logs:");
  console.log(chalk.cyan(`    vm0 logs ${runId}`));

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
    "Variables for ${{ vars.xxx }} (repeatable, falls back to env vars and .env)",
    collectKeyValue,
    {},
  )
  .option(
    "--secrets <KEY=value>",
    "Secrets for ${{ secrets.xxx }} (repeatable, falls back to env vars and .env)",
    collectKeyValue,
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
        secrets: Record<string, string>;
        artifactName?: string;
        artifactVersion?: string;
        volumeVersion: Record<string, string>;
        conversation?: string;
        verbose?: boolean;
      },
    ) => {
      const startTimestamp = new Date(); // Capture command start time for elapsed calculation

      const verbose = options.verbose;

      try {
        // 1. Parse identifier for optional version specifier
        const { name, version } = parseIdentifier(identifier);

        // 2. Resolve name to composeId and get compose content
        let composeId: string;
        let composeContent: unknown;

        if (isUUID(name)) {
          // It's a UUID compose ID - fetch compose to get content
          if (verbose) {
            console.log(chalk.gray(`  Using compose ID: ${identifier}`));
          }
          try {
            const compose = await apiClient.getComposeById(name);
            composeId = compose.id;
            composeContent = compose.content;
          } catch (error) {
            if (error instanceof Error) {
              console.error(chalk.red(`✗ Compose not found: ${name}`));
            }
            process.exit(1);
          }
        } else {
          // It's an agent name - resolve to compose ID
          if (verbose) {
            console.log(chalk.gray(`  Resolving agent name: ${name}`));
          }
          try {
            const compose = await apiClient.getComposeByName(name);
            composeId = compose.id;
            composeContent = compose.content;
            if (verbose) {
              console.log(chalk.gray(`  Resolved to compose ID: ${composeId}`));
            }
          } catch (error) {
            if (error instanceof Error) {
              console.error(chalk.red(`✗ Agent not found: ${name}`));
              console.error(
                chalk.gray(
                  "  Make sure you've composed the agent with: vm0 compose",
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
                chalk.gray("  Make sure the version hash is correct."),
              );
            }
            process.exit(1);
          }
        }
        // Note: "latest" version uses agentComposeId which resolves to HEAD

        // 4. Load vars and secrets with priority: CLI args > env vars > .env file
        const varNames = extractVarNames(composeContent);
        const vars = loadValues(options.vars, varNames);

        const secretNames = extractSecretNames(composeContent);
        const secrets = loadValues(options.secrets, secretNames);

        if (verbose && varNames.length > 0) {
          console.log(chalk.gray(`  Required vars: ${varNames.join(", ")}`));
          if (vars) {
            console.log(
              chalk.gray(`  Loaded vars: ${Object.keys(vars).join(", ")}`),
            );
          }
        }

        if (verbose && secretNames.length > 0) {
          console.log(
            chalk.gray(`  Required secrets: ${secretNames.join(", ")}`),
          );
          if (secrets) {
            console.log(
              chalk.gray(
                `  Loaded secrets: ${Object.keys(secrets).join(", ")}`,
              ),
            );
          }
        }

        // 5. Display starting message (verbose only)
        if (verbose) {
          logVerbosePreFlight("Creating agent run", [
            { label: "Prompt", value: prompt },
            { label: "Version", value: version || "latest (HEAD)" },
            {
              label: "Variables",
              value:
                vars && Object.keys(vars).length > 0
                  ? JSON.stringify(vars)
                  : undefined,
            },
            {
              label: "Secrets",
              value:
                secrets && Object.keys(secrets).length > 0
                  ? `${Object.keys(secrets).length} loaded`
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

        // 6. Call unified API (server handles all variable expansion)
        const response = await apiClient.createRun({
          // Use agentComposeVersionId if resolved, otherwise use agentComposeId (resolves to HEAD)
          ...(agentComposeVersionId
            ? { agentComposeVersionId }
            : { agentComposeId: composeId }),
          prompt,
          vars,
          secrets,
          artifactName: options.artifactName,
          artifactVersion: options.artifactVersion,
          volumeVersions:
            Object.keys(options.volumeVersion).length > 0
              ? options.volumeVersion
              : undefined,
          conversationId: options.conversation,
        });

        // 4. Check for immediate failure (e.g., missing secrets)
        if (response.status === "failed") {
          console.error(chalk.red("✗ Run preparation failed"));
          if (response.error) {
            console.error(chalk.gray(`  ${response.error}`));
          }
          process.exit(1);
        }

        // 5. Display run started info
        EventRenderer.renderRunStarted({
          runId: response.runId,
          sandboxId: response.sandboxId,
        });

        // 6. Poll for events and exit with appropriate code
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
              chalk.gray(
                "  Make sure you've composed the agent with: vm0 compose",
              ),
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

        // 4. Check for immediate failure (e.g., missing secrets)
        if (response.status === "failed") {
          console.error(chalk.red("✗ Run preparation failed"));
          if (response.error) {
            console.error(chalk.gray(`  ${response.error}`));
          }
          process.exit(1);
        }

        // 5. Display run started info
        EventRenderer.renderRunStarted({
          runId: response.runId,
          sandboxId: response.sandboxId,
        });

        // 6. Poll for events and exit with appropriate code
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

        // 4. Check for immediate failure (e.g., missing secrets)
        if (response.status === "failed") {
          console.error(chalk.red("✗ Run preparation failed"));
          if (response.error) {
            console.error(chalk.gray(`  ${response.error}`));
          }
          process.exit(1);
        }

        // 5. Display run started info
        EventRenderer.renderRunStarted({
          runId: response.runId,
          sandboxId: response.sandboxId,
        });

        // 6. Poll for events and exit with appropriate code
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
