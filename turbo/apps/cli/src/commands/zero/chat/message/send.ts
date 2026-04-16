import { readFileSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import { sendChatMessage } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";

export const sendCommand = new Command()
  .name("send")
  .description("Send a message to a web chat thread")
  .option("-t, --thread <id>", "Existing chat thread ID")
  .option("-a, --agent <agentId>", "Agent ID (creates a new thread)")
  .option("--text <message>", "Message text")
  .option("--title <title>", "Thread title (only with --agent)")
  .addHelpText(
    "after",
    `
Examples:
  Send to existing thread:   zero chat message send -t <thread-id> --text "Hello!"
  Send to agent (new thread): zero chat message send -a <agent-id> --text "Hello!"

Notes:
  - Either --thread or --agent is required; they are mutually exclusive
  - --text is required (or pipe via stdin)`,
  )
  .action(
    withErrorHandler(
      async (options: {
        thread?: string;
        agent?: string;
        text?: string;
        title?: string;
      }) => {
        let text = options.text;
        const { thread, agent, title } = options;

        // Validate mutual exclusion: exactly one of --thread or --agent
        if (!thread && !agent) {
          throw new Error("Either --thread or --agent must be provided", {
            cause: new Error(
              'Usage: zero chat message send -t THREAD_ID --text "your message"\n       zero chat message send -a AGENT_ID --text "your message"',
            ),
          });
        }
        if (thread && agent) {
          throw new Error("--thread and --agent are mutually exclusive", {
            cause: new Error(
              "Provide either --thread to send to an existing thread or --agent to create a new thread, not both",
            ),
          });
        }

        // Read from stdin if text not provided and stdin is explicitly piped
        if (!text && process.stdin.isTTY === false) {
          text = readFileSync("/dev/stdin", "utf8").trim();
        }

        if (!text) {
          throw new Error("--text is required", {
            cause: new Error(
              'Usage: zero chat message send -t THREAD_ID --text "your message"',
            ),
          });
        }

        const result = await sendChatMessage({
          thread: thread || undefined,
          agent: agent || undefined,
          text,
          title: title || undefined,
        });

        console.log(
          chalk.green(
            `✓ Message sent (id: ${result.messageId}, thread: ${result.threadId})`,
          ),
        );
      },
    ),
  );
