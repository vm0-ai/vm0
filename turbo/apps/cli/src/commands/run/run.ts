import { Command, Option } from "commander";
import chalk from "chalk";
import {
  getComposeById,
  getComposeByName,
  getComposeVersion,
  createRun,
} from "../../lib/api";
import { EventRenderer } from "../../lib/events/event-renderer";
import {
  collectKeyValue,
  collectVolumeVersions,
  isUUID,
  extractVarNames,
  extractSecretNames,
  loadValues,
  parseIdentifier,
  pollEvents,
  streamRealtimeEvents,
  logVerbosePreFlight,
  showNextSteps,
} from "./shared";

export const mainRunCommand = new Command()
  .name("run")
  .description("Run an agent")
  .argument(
    "<agent-name>",
    "Agent reference: [scope/]name[:version] (e.g., 'my-agent', 'lancy/my-agent:abc123', 'my-agent:latest')",
  )
  .argument("<prompt>", "Prompt for the agent")
  .option(
    "--env-file <path>",
    "Load environment variables from file (priority: CLI flags > file > env vars)",
  )
  .option(
    "--vars <KEY=value>",
    "Variables for ${{ vars.xxx }} (repeatable, falls back to --env-file or env vars)",
    collectKeyValue,
    {},
  )
  .option(
    "--secrets <KEY=value>",
    "Secrets for ${{ secrets.xxx }} (repeatable, falls back to --env-file or env vars)",
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
  .option(
    "--experimental-realtime",
    "Use realtime event streaming instead of polling (experimental)",
  )
  .option(
    "--model-provider <type>",
    "Override model provider (e.g., anthropic-api-key)",
  )
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .action(
    // eslint-disable-next-line complexity -- TODO: refactor complex function
    async (
      identifier: string,
      prompt: string,
      options: {
        envFile?: string;
        vars: Record<string, string>;
        secrets: Record<string, string>;
        artifactName?: string;
        artifactVersion?: string;
        volumeVersion: Record<string, string>;
        conversation?: string;
        verbose?: boolean;
        experimentalRealtime?: boolean;
        modelProvider?: string;
        debugNoMockClaude?: boolean;
      },
    ) => {
      const startTimestamp = new Date(); // Capture command start time for elapsed calculation

      const verbose = options.verbose;

      try {
        // 1. Parse identifier for optional scope and version specifier
        const { scope, name, version } = parseIdentifier(identifier);

        // 2. Resolve name to composeId and get compose content
        let composeId: string;
        let composeContent: unknown;

        if (isUUID(name)) {
          // It's a UUID compose ID - fetch compose to get content
          if (verbose) {
            console.log(chalk.dim(`  Using compose ID: ${identifier}`));
          }
          const compose = await getComposeById(name);
          composeId = compose.id;
          composeContent = compose.content;
        } else {
          // It's an agent name - resolve to compose ID
          if (verbose) {
            const displayRef = scope ? `${scope}/${name}` : name;
            console.log(chalk.dim(`  Resolving agent: ${displayRef}`));
          }
          const compose = await getComposeByName(name, scope);
          if (!compose) {
            console.error(chalk.red(`✗ Agent not found: ${identifier}`));
            console.error(
              chalk.dim(
                "  Make sure you've composed the agent with: vm0 compose",
              ),
            );
            process.exit(1);
          }

          composeId = compose.id;
          composeContent = compose.content;
          if (verbose) {
            console.log(chalk.dim(`  Resolved to compose ID: ${composeId}`));
          }
        }

        // 3. Resolve version if specified
        let agentComposeVersionId: string | undefined;

        if (version && version !== "latest") {
          // Resolve version hash to full version ID
          if (verbose) {
            console.log(chalk.dim(`  Resolving version: ${version}`));
          }
          try {
            const versionInfo = await getComposeVersion(composeId, version);
            agentComposeVersionId = versionInfo.versionId;
            if (verbose) {
              console.log(
                chalk.dim(
                  `  Resolved to version ID: ${agentComposeVersionId.slice(0, 8)}...`,
                ),
              );
            }
          } catch {
            // Wrap version errors with specific message for better error handling
            throw new Error(`Version not found: ${version}`);
          }
        }
        // Note: "latest" version uses agentComposeId which resolves to HEAD

        // 4. Load vars and secrets with priority: CLI args > --env-file > env vars
        const varNames = extractVarNames(composeContent);
        const vars = loadValues(options.vars, varNames, options.envFile);

        const secretNames = extractSecretNames(composeContent);
        const secrets = loadValues(
          options.secrets,
          secretNames,
          options.envFile,
        );

        if (verbose && varNames.length > 0) {
          console.log(chalk.dim(`  Required vars: ${varNames.join(", ")}`));
          if (vars) {
            console.log(
              chalk.dim(`  Loaded vars: ${Object.keys(vars).join(", ")}`),
            );
          }
        }

        if (verbose && secretNames.length > 0) {
          console.log(
            chalk.dim(`  Required secrets: ${secretNames.join(", ")}`),
          );
          if (secrets) {
            console.log(
              chalk.dim(`  Loaded secrets: ${Object.keys(secrets).join(", ")}`),
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
        const response = await createRun({
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
          modelProvider: options.modelProvider,
          debugNoMockClaude: options.debugNoMockClaude || undefined,
        });

        // 4. Check for immediate failure (e.g., missing secrets)
        if (response.status === "failed") {
          console.error(chalk.red("✗ Run preparation failed"));
          if (response.error) {
            console.error(chalk.dim(`  ${response.error}`));
          }
          process.exit(1);
        }

        // 5. Display run started info
        EventRenderer.renderRunStarted({
          runId: response.runId,
          sandboxId: response.sandboxId,
        });

        // 6. Poll or stream for events and exit with appropriate code
        const result = options.experimentalRealtime
          ? await streamRealtimeEvents(response.runId, {
              verbose,
              startTimestamp,
            })
          : await pollEvents(response.runId, {
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
          } else if (error.message.includes("Realtime connection failed")) {
            console.error(chalk.red("✗ Realtime streaming failed"));
            console.error(chalk.dim(`  ${error.message}`));
            console.error(
              chalk.dim("  Try running without --experimental-realtime"),
            );
          } else if (error.message.startsWith("Version not found:")) {
            console.error(chalk.red(`✗ ${error.message}`));
            console.error(chalk.dim("  Make sure the version hash is correct"));
          } else if (error.message.startsWith("Environment file not found:")) {
            console.error(chalk.red(`✗ ${error.message}`));
          } else if (error.message.includes("not found")) {
            console.error(chalk.red(`✗ Agent not found: ${identifier}`));
            console.error(
              chalk.dim(
                "  Make sure you've composed the agent with: vm0 compose",
              ),
            );
          } else {
            console.error(chalk.red("✗ Run failed"));
            console.error(chalk.dim(`  ${error.message}`));
          }
        } else {
          console.error(chalk.red("✗ An unexpected error occurred"));
        }
        process.exit(1);
      }
    },
  );
