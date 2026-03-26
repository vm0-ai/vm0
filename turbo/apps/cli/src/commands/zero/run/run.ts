import { Command } from "commander";
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
    "--append-system-prompt <text>",
    "Append text to the agent's system prompt",
  )
  .option(
    "--model-provider <type>",
    "Override model provider (e.g., anthropic-api-key)",
  )
  .option("--verbose", "Show full tool inputs and outputs")
  .action(
    withErrorHandler(
      async (
        agentId: string,
        prompt: string,
        options: {
          appendSystemPrompt?: string;
          modelProvider?: string;
          verbose?: boolean;
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
