import { Command } from "commander";
import { createZeroRun } from "../../../lib/api";
import { isUUID, renderRunCreated } from "../../run/shared";
import { withErrorHandler } from "../../../lib/command";
import { pollZeroEvents, showZeroNextSteps } from "./shared";

export const continueCommand = new Command()
  .name("continue")
  .description("Continue a previous delegation from a session")
  .argument("<session-id>", "Session ID from a previous run")
  .argument("<prompt>", "Follow-up prompt for the agent")
  .option(
    "--append-system-prompt <text>",
    "Append text to the agent's system prompt",
  )
  .option(
    "--model-provider <type>",
    "Override model provider (e.g., anthropic-api-key)",
  )
  .option("--verbose", "Show full tool inputs and outputs")
  .addHelpText(
    "after",
    `
Examples:
  zero run continue <session-id> "now deploy it"
  zero run continue <session-id> "add tests" --verbose

Notes:
  - The session ID is printed after a successful "zero run" delegation
  - Continues the same agent session with full prior context`,
  )
  .action(
    withErrorHandler(
      async (
        sessionId: string,
        prompt: string,
        options: {
          appendSystemPrompt?: string;
          modelProvider?: string;
          verbose?: boolean;
        },
      ) => {
        // 1. Validate session-id is a UUID
        if (!isUUID(sessionId)) {
          throw new Error(`Invalid session ID format: ${sessionId}`, {
            cause: new Error("Session ID must be a valid UUID"),
          });
        }

        // 2. Create zero run with sessionId (no agentId needed)
        const response = await createZeroRun({
          sessionId,
          prompt,
          appendSystemPrompt: options.appendSystemPrompt,
          modelProvider: options.modelProvider,
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
