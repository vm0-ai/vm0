import { Command, Option } from "commander";
import { createZeroRun } from "../../../lib/api";
import { isUUID, renderRunCreated } from "../../run/shared";
import { withErrorHandler } from "../../../lib/command";
import { pollZeroEvents, showZeroNextSteps } from "./shared";

export const mainRunCommand = new Command()
  .name("run")
  .description("Delegate a task to a teammate agent")
  .argument("<agent-id>", "Agent UUID (from `zero agent list`)")
  .argument("<prompt>", "Task prompt for the agent")
  .option(
    "--model-provider <type>",
    "Override model provider (e.g., anthropic-api-key)",
  )
  .option("--verbose", "Show full tool inputs and outputs")
  .addOption(new Option("--debug-no-mock-claude").hideHelp())
  .addHelpText(
    "after",
    `
Examples:
  Delegate a task:       zero run <agent-id> "summarize the latest issues"
  With verbose output:   zero run <agent-id> "fix the bug" --verbose

Notes:
  - Get agent IDs from "zero agent list"
  - The command streams events until the delegated run completes
  - On success, a session ID is printed for follow-up with "zero run continue"`,
  )
  .action(
    withErrorHandler(
      async (
        agentId: string,
        prompt: string,
        options: {
          modelProvider?: string;
          verbose?: boolean;
          debugNoMockClaude?: boolean;
        },
      ) => {
        // 1. Validate agent-id is a UUID
        if (!isUUID(agentId)) {
          throw new Error(`Invalid agent ID format: ${agentId}`, {
            cause: new Error(
              "Agent ID must be a valid UUID. Use `zero agent list` to find agent IDs.",
            ),
          });
        }

        // 2. Create zero run
        const response = await createZeroRun({
          agentId,
          prompt,
          modelProvider: options.modelProvider,
          debugNoMockClaude: options.debugNoMockClaude,
        });

        // 3. Check for immediate failure
        if (response.status === "failed") {
          throw new Error(
            "Run preparation failed",
            response.error ? { cause: new Error(response.error) } : undefined,
          );
        }

        // 4. Display run started/queued info
        renderRunCreated(response);

        // 5. Poll for events
        const result = await pollZeroEvents(response.runId, {
          verbose: options.verbose,
        });
        if (!result.succeeded) {
          throw new Error("Run failed");
        }

        // 6. Show next steps
        showZeroNextSteps(result);
      },
    ),
  );
