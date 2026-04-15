import { Command, Option } from "commander";
import { getCheckpoint, createRun } from "../../lib/api";
import {
  collectKeyValue,
  collectVolumeVersions,
  isUUID,
  loadValues,
  parseArtifact,
  parsePermissionPolicies,
  pollEvents,
  showNextSteps,
  renderRunCreated,
} from "./shared";
import { withErrorHandler } from "../../lib/command";

export const resumeCommand = new Command()
  .name("resume")
  .description("Resume an agent run from a checkpoint (uses all snapshot data)")
  .argument("<checkpointId>", "Checkpoint ID to resume from")
  .argument("<prompt>", "Prompt for the resumed agent")
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
    "--volume-version <name=version>",
    "Volume version override (repeatable)",
    collectVolumeVersions,
    {},
  )
  .option(
    "--artifact <name[:version]>",
    "Artifact storage (format: name or name:version)",
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
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .action(
    withErrorHandler(
      async (
        checkpointId: string,
        prompt: string,
        options: {
          envFile?: string;
          vars: Record<string, string>;
          secrets: Record<string, string>;
          artifact?: string;
          appendSystemPrompt?: string;
          disallowedTools?: string[];
          tools?: string[];
          settings?: string;
          permissionPolicies?: string;
          verbose?: boolean;
          debugNoMockClaude?: boolean;
        },
        command: { optsWithGlobals: () => Record<string, unknown> },
      ) => {
        // Commander.js quirk: when parent command has same option name,
        // the option value goes to parent. Use optsWithGlobals() to get all options.
        const allOpts = command.optsWithGlobals() as {
          envFile?: string;
          vars: Record<string, string>;
          secrets: Record<string, string>;
          volumeVersion: Record<string, string>;
          artifact?: string;
          appendSystemPrompt?: string;
          disallowedTools?: string[];
          tools?: string[];
          settings?: string;
          permissionPolicies?: string;
          verbose?: boolean;
          debugNoMockClaude?: boolean;
        };

        // Merge vars and secrets from command options
        const vars = { ...allOpts.vars, ...options.vars };
        const secrets = { ...allOpts.secrets, ...options.secrets };

        // 1. Validate checkpoint ID format
        if (!isUUID(checkpointId)) {
          throw new Error(`Invalid checkpoint ID format: ${checkpointId}`, {
            cause: new Error("Checkpoint ID must be a valid UUID"),
          });
        }

        // 2. Fetch checkpoint info to get required secret names
        // This allows loading secrets from environment variables
        const checkpointInfo = await getCheckpoint(checkpointId);
        const requiredSecretNames =
          checkpointInfo.agentComposeSnapshot.secretNames || [];

        // 3. Load secrets from CLI options + --env-file + environment variables
        // Priority: CLI flags > --env-file > env vars
        const envFile = options.envFile || allOpts.envFile;
        const loadedSecrets = loadValues(secrets, requiredSecretNames, envFile);

        // 4. Parse artifact flag
        const artifactParsed = parseArtifact(
          options.artifact || allOpts.artifact,
        );

        // 5. Call unified API with checkpointId
        const response = await createRun({
          checkpointId,
          prompt,
          vars: Object.keys(vars).length > 0 ? vars : undefined,
          secrets: loadedSecrets,
          artifactName: artifactParsed?.artifactName,
          artifactVersion: artifactParsed?.artifactVersion,
          volumeVersions:
            Object.keys(allOpts.volumeVersion).length > 0
              ? allOpts.volumeVersion
              : undefined,
          appendSystemPrompt:
            options.appendSystemPrompt || allOpts.appendSystemPrompt,
          disallowedTools: options.disallowedTools || allOpts.disallowedTools,
          tools: options.tools || allOpts.tools,
          settings: options.settings || allOpts.settings,
          permissionPolicies: parsePermissionPolicies(
            options.permissionPolicies || allOpts.permissionPolicies,
          ),
          debugNoMockClaude:
            options.debugNoMockClaude || allOpts.debugNoMockClaude || undefined,
        });

        // 4. Check for immediate failure (e.g., missing secrets)
        if (response.status === "failed") {
          throw new Error(
            "Run preparation failed",
            response.error ? { cause: new Error(response.error) } : undefined,
          );
        }

        // 5. Display run started/queued info
        renderRunCreated(response);

        // 6. Poll for events and exit with appropriate code
        const verbose = options.verbose || allOpts.verbose;
        const result = await pollEvents(response.runId, { verbose });
        if (!result.succeeded) {
          throw new Error("Run failed");
        }
        showNextSteps(result);
      },
    ),
  );
