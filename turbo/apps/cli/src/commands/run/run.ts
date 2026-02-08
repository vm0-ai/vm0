import { Command, Option } from "commander";
import chalk from "chalk";
import {
  getComposeById,
  getComposeByName,
  getComposeVersion,
  getScope,
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
  showNextSteps,
  handleRunError,
} from "./shared";
import { silentUpgradeAfterCommand } from "../../lib/utils/update-checker";

declare const __CLI_VERSION__: string;

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
  .option(
    "--experimental-realtime",
    "Use realtime event streaming instead of polling (experimental)",
  )
  .option(
    "--model-provider <type>",
    "Override model provider (e.g., anthropic-api-key)",
  )
  .option("--verbose", "Show full tool inputs and outputs")
  .option(
    "--experimental-shared-agent",
    "Allow running agents shared by other users (required when running scope/agent format)",
  )
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .addOption(new Option("--no-auto-update").hideHelp())
  .action(
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
        experimentalRealtime?: boolean;
        modelProvider?: string;
        verbose?: boolean;
        experimentalSharedAgent?: boolean;
        debugNoMockClaude?: boolean;
        autoUpdate?: boolean;
      },
    ) => {
      try {
        // 1. Parse identifier for optional scope and version specifier
        const { scope, name, version } = parseIdentifier(identifier);

        // 1.5. Validate: running another user's agent requires explicit opt-in
        if (scope && !options.experimentalSharedAgent) {
          // Check if it's the user's own scope
          const userScope = await getScope();
          const isOwnScope = userScope.slug === scope;

          if (!isOwnScope) {
            console.error(
              chalk.red(
                `✗ Running shared agents requires --experimental-shared-agent flag`,
              ),
            );
            console.error();
            console.error(
              chalk.dim(
                "  Running agent from other users carries security risks.",
              ),
            );
            console.error(chalk.dim("  Only run agents from users you trust"));
            console.error();
            console.error("Example:");
            console.error(
              chalk.cyan(
                `  vm0 run ${identifier} --experimental-shared-agent "your prompt"`,
              ),
            );
            process.exit(1);
          }
        }

        // 2. Resolve name to composeId and get compose content
        let composeId: string;
        let composeContent: unknown;

        if (isUUID(name)) {
          // It's a UUID compose ID - fetch compose to get content
          const compose = await getComposeById(name);
          composeId = compose.id;
          composeContent = compose.content;
        } else {
          // It's an agent name - resolve to compose ID
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
        }

        // 3. Resolve version if specified
        let agentComposeVersionId: string | undefined;

        if (version && version !== "latest") {
          // Resolve version hash to full version ID
          try {
            const versionInfo = await getComposeVersion(composeId, version);
            agentComposeVersionId = versionInfo.versionId;
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

        // 5. Call unified API (server handles all variable expansion)
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
              verbose: options.verbose,
            })
          : await pollEvents(response.runId, { verbose: options.verbose });
        if (!result.succeeded) {
          process.exit(1);
        }
        showNextSteps(result);

        // Silent upgrade after successful command completion
        if (options.autoUpdate !== false) {
          await silentUpgradeAfterCommand(__CLI_VERSION__);
        }
      } catch (error) {
        handleRunError(error, identifier);
      }
    },
  );
