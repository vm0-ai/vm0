import { Command, Option } from "commander";
import {
  getComposeById,
  getComposeByName,
  getComposeVersion,
  createRun,
} from "../../lib/api";
import {
  collectKeyValue,
  collectVolumeVersions,
  collectMounts,
  collectArtifacts,
  isUUID,
  extractVarNames,
  extractSecretNames,
  loadValues,
  parsePermissionPolicies,
  parseIdentifier,
  pollEvents,
  showNextSteps,
  renderRunCreated,
} from "./shared";
import {
  startSilentUpgrade,
  waitForSilentUpgrade,
} from "../../lib/utils/update-checker";
import { withErrorHandler } from "../../lib/command";

declare const __CLI_VERSION__: string;

export const mainRunCommand = new Command()
  .name("run")
  .description("Run an agent")
  .argument(
    "<agent-name>",
    "Agent reference: name[:version] (e.g., 'my-agent', 'my-agent:abc123', 'my-agent:latest')",
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
  .option(
    "--artifact <artifact>",
    "Mount an artifact (repeatable, format: name:/path or name:version:/path)",
    collectArtifacts,
    [],
  )
  .option(
    "--volume-version <name=version>",
    "Volume version override (repeatable, format: volumeName=version)",
    collectVolumeVersions,
    {},
  )
  .option(
    "--volume <volume>",
    "Mount a volume (repeatable, format: name:/path or name:version:/path)",
    collectMounts,
    [],
  )
  .option("--memory <name>", "Memory storage name")
  .option(
    "--conversation <id>",
    "Resume from conversation ID (for fine-grained control)",
  )
  .option(
    "--append-system-prompt <text>",
    "Append text to the agent's system prompt",
  )
  .option(
    "--disallowed-tools <tools...>",
    "Tools to disable in Claude CLI (e.g., CronCreate WebSearch)",
  )
  .option(
    "--tools <tools...>",
    "Built-in tools to make available in Claude CLI (e.g., Bash Edit Read)",
  )
  .option(
    "--settings <json>",
    "Settings JSON to pass to Claude CLI (e.g., hooks, permissions)",
  )
  .option(
    "--permission-policies <json>",
    'Permission policies JSON (e.g., \'{"github": {"actions:read": "allow"}}\')',
  )
  .option("--verbose", "Show full tool inputs and outputs")
  .option(
    "--capture-network-bodies",
    "Capture HTTP request headers, request bodies, and response bodies in network logs",
  )
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .addOption(new Option("--no-auto-update").hideHelp())
  .action(
    withErrorHandler(
      async (
        identifier: string,
        prompt: string,
        options: {
          envFile?: string;
          vars: Record<string, string>;
          secrets: Record<string, string>;
          artifact: Array<{
            name: string;
            version?: string;
            mountPath: string;
          }>;
          memory?: string;
          volumeVersion: Record<string, string>;
          volume: Array<{ name: string; version?: string; mountPath: string }>;
          conversation?: string;
          appendSystemPrompt?: string;
          disallowedTools?: string[];
          tools?: string[];
          settings?: string;
          permissionPolicies?: string;
          verbose?: boolean;
          captureNetworkBodies?: boolean;
          debugNoMockClaude?: boolean;
          autoUpdate?: boolean;
        },
      ) => {
        // Start upgrade in background at command start (runs in parallel)
        if (options.autoUpdate !== false) {
          await startSilentUpgrade(__CLI_VERSION__);
        }

        // 1. Parse identifier for optional version specifier
        const { name, version } = parseIdentifier(identifier);

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
          const compose = await getComposeByName(name);
          if (!compose) {
            throw new Error(`Agent not found: ${identifier}`, {
              cause: new Error(
                "Make sure you've composed the agent with: vm0 compose",
              ),
            });
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
          } catch (error) {
            throw new Error(`Version not found: ${version}`, {
              cause: error,
            });
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

        // 5. Prepare optional fields
        const volumeVersions =
          Object.keys(options.volumeVersion).length > 0
            ? options.volumeVersion
            : undefined;
        const additionalVolumes =
          options.volume.length > 0 ? options.volume : undefined;
        const artifacts =
          options.artifact.length > 0 ? options.artifact : undefined;

        // 6. Call unified API (server handles all variable expansion)
        const response = await createRun({
          // Use agentComposeVersionId if resolved, otherwise use agentComposeId (resolves to HEAD)
          ...(agentComposeVersionId
            ? { agentComposeVersionId }
            : { agentComposeId: composeId }),
          prompt,
          vars,
          secrets,
          artifacts,
          memoryName: options.memory,
          volumeVersions,
          additionalVolumes,
          conversationId: options.conversation,
          appendSystemPrompt: options.appendSystemPrompt,
          disallowedTools: options.disallowedTools,
          tools: options.tools,
          settings: options.settings,
          permissionPolicies: parsePermissionPolicies(
            options.permissionPolicies,
          ),
          captureNetworkBodies: options.captureNetworkBodies || undefined,
          debugNoMockClaude: options.debugNoMockClaude || undefined,
        });

        // 7. Check for immediate failure (e.g., missing secrets)
        if (response.status === "failed") {
          throw new Error(
            "Run preparation failed",
            response.error ? { cause: new Error(response.error) } : undefined,
          );
        }

        // 8. Display run started/queued info
        renderRunCreated(response);

        // 9. Poll for events and exit with appropriate code
        const result = await pollEvents(response.runId, {
          verbose: options.verbose,
        });
        if (!result.succeeded) {
          throw new Error("Run failed");
        }
        showNextSteps(result);

        // Wait for upgrade at command end (shows warning if failed)
        if (options.autoUpdate !== false) {
          await waitForSilentUpgrade();
        }
      },
    ),
  );
