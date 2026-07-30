import chalk from "chalk";
import { Command } from "commander";

import {
  createZeroChatThread,
  getZeroChatThreadAgentId,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { isUuid } from "../../../lib/utils/uuid";
import { printChatUsageError } from "./shared";

interface CreateOptions {
  readonly agent?: string;
  readonly json?: boolean;
  readonly model?: string;
}

/**
 * Agent that owns the new thread: an explicit `--agent`, otherwise the agent of
 * the chat the command runs in.
 */
async function resolveAgentId(
  flagAgentId: string | undefined,
): Promise<string> {
  const agentId = flagAgentId?.trim();
  if (agentId) {
    return agentId;
  }

  const currentThreadId = process.env.ZERO_CHAT_THREAD_ID?.trim();
  if (!currentThreadId) {
    printChatUsageError(
      "ZERO_CHAT_THREAD_ID is not set",
      "Pass --agent <agent-id> or run inside a Zero web chat thread.",
    );
  }
  if (!isUuid(currentThreadId)) {
    printChatUsageError(
      `Invalid thread ID "${currentThreadId}" — expected a UUID`,
      "Pass --agent <agent-id> to choose the agent explicitly.",
    );
  }

  return await getZeroChatThreadAgentId({ threadId: currentThreadId });
}

export const createCommand = new Command()
  .name("create")
  .description("Create a new web chat thread")
  .argument("<title...>", "Chat title")
  .option(
    "--agent <id>",
    "Agent ID that owns the thread (defaults to this chat's agent)",
  )
  .option(
    "--model <id>",
    "Model for the thread (defaults to the current run's model)",
  )
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Create a chat:     zero chat create "Launch plan"
  Pick the model:    zero chat create "Launch plan" --model claude-sonnet-5
  Pick the agent:    zero chat create "Launch plan" --agent <agent-id>
  Print JSON:        zero chat create "Launch plan" --json

Notes:
  - Creates an empty thread; send its first message with zero chat send
  - Defaults --agent to the agent of ZERO_CHAT_THREAD_ID
  - Defaults --model to the model of the run that owns ZERO_TOKEN
  - The new thread never inherits this chat's history, so the first message must be self-contained
  - Authenticates via ZERO_TOKEN (requires chat-thread:write, and chat-thread:read to default --agent)`,
  )
  .action(
    withErrorHandler(async (titleParts: string[], options: CreateOptions) => {
      const title = titleParts.join(" ").trim();
      if (!title) {
        printChatUsageError(
          "Chat title is required",
          'Run: zero chat create "New title"',
        );
      }

      const agentId = await resolveAgentId(options.agent);
      const thread = await createZeroChatThread({
        agentId,
        title,
        ...(options.model === undefined ? {} : { model: options.model }),
      });

      if (options.json) {
        console.log(
          JSON.stringify({
            threadId: thread.threadId,
            title: thread.title,
            selectedModel: thread.selectedModel,
            agentId,
          }),
        );
        return;
      }

      console.log(chalk.green("✓ Chat thread created"));
      console.log(chalk.dim(`  Thread: ${thread.threadId}`));
      console.log(chalk.dim(`  Title:  ${title}`));
      console.log(
        chalk.dim(`  Model:  ${thread.selectedModel ?? "(default)"}`),
      );
      console.log(chalk.dim(`  Agent:  ${agentId}`));
      console.log();
      console.log("Send the first message:");
      console.log(
        chalk.cyan(
          `  zero chat send --thread-id ${thread.threadId} --text "<message>"`,
        ),
      );
    }),
  );
