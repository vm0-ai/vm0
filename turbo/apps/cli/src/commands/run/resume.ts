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
  logVerbosePreFlight,
  showNextSteps,
} from "./shared";

export const resumeCommand = new Command()
  .name("resume")
  .description("Resume an agent run from a checkpoint (uses all snapshot data)")
  .argument("<checkpointId>", "Checkpoint ID to resume from")
  .argument("<prompt>", "Prompt for the resumed agent")
  .option(
    "--vars <KEY=value>",
    "Variables for ${{ vars.xxx }} (repeatable, falls back to env vars and .env)",
    collectKeyValue,
    {},
  )
  .option(
    "--secrets <KEY=value>",
    "Secrets for ${{ secrets.xxx }} (repeatable, required for resume)",
    collectKeyValue,
    {},
  )
  .option(
    "--volume-version <name=version>",
    "Volume version override (repeatable)",
    collectVolumeVersions,
    {},
  )
  .option("-v, --verbose", "Show verbose output with timing information")
  .option(
    "--experimental-realtime",
    "Use realtime event streaming instead of polling (experimental)",
  )
  .option(
    "--model-provider <type>",
    "Override model provider for LLM credentials (e.g., anthropic-api-key)",
  )
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .action(
    // eslint-disable-next-line complexity -- TODO: refactor complex function
    async (
      checkpointId: string,
      prompt: string,
      options: {
        vars: Record<string, string>;
        secrets: Record<string, string>;
        verbose?: boolean;
        experimentalRealtime?: boolean;
        modelProvider?: string;
        debugNoMockClaude?: boolean;
      },
      command: { optsWithGlobals: () => Record<string, unknown> },
    ) => {
      const startTimestamp = new Date(); // Capture command start time for elapsed calculation

      // Commander.js quirk: when parent command has same option name,
      // the option value goes to parent. Use optsWithGlobals() to get all options.
      const allOpts = command.optsWithGlobals() as {
        vars: Record<string, string>;
        secrets: Record<string, string>;
        volumeVersion: Record<string, string>;
        verbose?: boolean;
        experimentalRealtime?: boolean;
        modelProvider?: string;
        debugNoMockClaude?: boolean;
      };

      const verbose = options.verbose || allOpts.verbose;

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

        // 3. Load secrets from CLI options + environment variables
        // CLI-provided secrets take precedence, then fall back to env vars
        const loadedSecrets = loadValues(secrets, requiredSecretNames);

        // 4. Display starting message (verbose only)
        if (verbose) {
          logVerbosePreFlight("Resuming agent run from checkpoint", [
            { label: "Checkpoint ID", value: checkpointId },
            { label: "Prompt", value: prompt },
            {
              label: "Variables",
              value:
                Object.keys(vars).length > 0 ? JSON.stringify(vars) : undefined,
            },
            {
              label: "Secrets",
              value:
                loadedSecrets && Object.keys(loadedSecrets).length > 0
                  ? `${Object.keys(loadedSecrets).length} loaded`
                  : undefined,
            },
            {
              label: "Volume overrides",
              value:
                Object.keys(allOpts.volumeVersion).length > 0
                  ? JSON.stringify(allOpts.volumeVersion)
                  : undefined,
            },
          ]);
        }

        // 5. Call unified API with checkpointId
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
        const result = experimentalRealtime
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
          } else if (error.message.includes("not found")) {
            console.error(chalk.red(`✗ Checkpoint not found: ${checkpointId}`));
          } else {
            console.error(chalk.red("✗ Resume failed"));
            console.error(chalk.dim(`  ${error.message}`));
          }
        } else {
          console.error(chalk.red("✗ An unexpected error occurred"));
        }
        process.exit(1);
      }
    },
  );
