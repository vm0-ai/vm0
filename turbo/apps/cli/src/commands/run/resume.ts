import { Command, Option } from "commander";
import chalk from "chalk";
import { getCheckpoint, createRun } from "../../lib/api";
import { EventRenderer } from "../../lib/events/event-renderer";
import {
  collectKeyValue,
  collectVolumeVersions,
  isUUID,
  loadValues,
  pollEvents,
  streamRealtimeEvents,
  showNextSteps,
  handleResumeOrContinueError,
} from "./shared";

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
    "--experimental-realtime",
    "Use realtime event streaming instead of polling (experimental)",
  )
  .option(
    "--model-provider <type>",
    "Override model provider (e.g., anthropic-api-key)",
  )
  .option("--verbose", "Show full tool inputs and outputs")
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .action(
    async (
      checkpointId: string,
      prompt: string,
      options: {
        envFile?: string;
        vars: Record<string, string>;
        secrets: Record<string, string>;
        experimentalRealtime?: boolean;
        modelProvider?: string;
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
        experimentalRealtime?: boolean;
        modelProvider?: string;
        verbose?: boolean;
        debugNoMockClaude?: boolean;
      };

      // Merge vars and secrets from command options
      const vars = { ...allOpts.vars, ...options.vars };
      const secrets = { ...allOpts.secrets, ...options.secrets };

      try {
        // 1. Validate checkpoint ID format
        if (!isUUID(checkpointId)) {
          console.error(
            chalk.red(`✗ Invalid checkpoint ID format: ${checkpointId}`),
          );
          console.error(chalk.dim("  Checkpoint ID must be a valid UUID"));
          process.exit(1);
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

        // 4. Call unified API with checkpointId
        const response = await createRun({
          checkpointId,
          prompt,
          vars: Object.keys(vars).length > 0 ? vars : undefined,
          secrets: loadedSecrets,
          volumeVersions:
            Object.keys(allOpts.volumeVersion).length > 0
              ? allOpts.volumeVersion
              : undefined,
          modelProvider: options.modelProvider || allOpts.modelProvider,
          debugNoMockClaude:
            options.debugNoMockClaude || allOpts.debugNoMockClaude || undefined,
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
        const experimentalRealtime =
          options.experimentalRealtime || allOpts.experimentalRealtime;
        const verbose = options.verbose || allOpts.verbose;
        const result = experimentalRealtime
          ? await streamRealtimeEvents(response.runId, { verbose })
          : await pollEvents(response.runId, { verbose });
        if (!result.succeeded) {
          process.exit(1);
        }
        showNextSteps(result);
      } catch (error) {
        handleResumeOrContinueError(
          error,
          "Resume",
          checkpointId,
          "Checkpoint",
        );
      }
    },
  );
