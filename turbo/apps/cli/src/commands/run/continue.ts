import { Command } from "commander";
import chalk from "chalk";
import { apiClient } from "../../lib/api/api-client";
import { EventRenderer } from "../../lib/events/event-renderer";
import {
  collectKeyValue,
  collectVolumeVersions,
  isUUID,
  loadValues,
  pollEvents,
  logVerbosePreFlight,
  showNextSteps,
} from "./shared";

export const continueCommand = new Command()
  .name("continue")
  .description(
    "Continue an agent run from a session (uses latest artifact version)",
  )
  .argument("<agentSessionId>", "Agent session ID to continue from")
  .argument("<prompt>", "Prompt for the continued agent")
  .option(
    "--vars <KEY=value>",
    "Variables for ${{ vars.xxx }} (repeatable, falls back to env vars and .env)",
    collectKeyValue,
    {},
  )
  .option(
    "--secrets <KEY=value>",
    "Secrets for ${{ secrets.xxx }} (repeatable, required for continue)",
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
  .option("--debug-no-mock-claude")
  .action(
    async (
      agentSessionId: string,
      prompt: string,
      options: {
        vars: Record<string, string>;
        secrets: Record<string, string>;
        verbose?: boolean;
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
        debugNoMockClaude?: boolean;
      };

      const verbose = options.verbose || allOpts.verbose;

      // Merge vars and secrets from command options
      const vars = { ...allOpts.vars, ...options.vars };
      const secrets = { ...allOpts.secrets, ...options.secrets };

      try {
        // 1. Validate session ID format
        if (!isUUID(agentSessionId)) {
          console.error(
            chalk.red(`✗ Invalid agent session ID format: ${agentSessionId}`),
          );
          console.error(chalk.dim("  Agent session ID must be a valid UUID"));
          process.exit(1);
        }

        // 2. Fetch session info to get required secret names
        // This allows loading secrets from environment variables
        const sessionInfo = await apiClient.getSession(agentSessionId);
        const requiredSecretNames = sessionInfo.secretNames || [];

        // 3. Load secrets from CLI options + environment variables
        // CLI-provided secrets take precedence, then fall back to env vars
        const loadedSecrets = loadValues(secrets, requiredSecretNames);

        // 4. Display starting message (verbose only)
        if (verbose) {
          logVerbosePreFlight("Continuing agent run from session", [
            { label: "Session ID", value: agentSessionId },
            { label: "Prompt", value: prompt },
            { label: "Note", value: "Using latest artifact version" },
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

        // 5. Call unified API with sessionId
        const response = await apiClient.createRun({
          sessionId: agentSessionId,
          prompt,
          vars: Object.keys(vars).length > 0 ? vars : undefined,
          secrets: loadedSecrets,
          volumeVersions:
            Object.keys(allOpts.volumeVersion).length > 0
              ? allOpts.volumeVersion
              : undefined,
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
            console.error(chalk.dim(`  ${error.message}`));
          }
        } else {
          console.error(chalk.red("✗ An unexpected error occurred"));
        }
        process.exit(1);
      }
    },
  );
