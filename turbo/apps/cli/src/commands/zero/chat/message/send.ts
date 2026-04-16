import { readFileSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import { sendChatMessage } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";

export const sendCommand = new Command()
  .name("send")
  .description("Send a message to a web chat thread")
  .option("-t, --thread <id>", "Existing chat thread ID")
  .option("-u, --user <userId>", "Target user ID (creates a new thread)")
  .option("-a, --agent <agentId>", "Agent ID (required with --user)")
  .option("--text <message>", "Message text")
  .addHelpText(
    "after",
    `
Examples:
  Send to existing thread:  zero chat message send -t <thread-id> --text "Hello!"
  Send to user (new thread): zero chat message send -u <user-id> -a <agent-id> --text "Hello!"

Notes:
  - Either --thread or --user is required; they are mutually exclusive
  - --agent is required when using --user
  - --text is required (or pipe via stdin)`,
  )
  .action(
    withErrorHandler(
      async (options: {
        thread?: string;
        user?: string;
        agent?: string;
        text?: string;
      }) => {
        let text = options.text;
        const { thread, user, agent } = options;

        // Validate mutual exclusion: exactly one of --thread or --user
        if (!thread && !user) {
          throw new Error("Either --thread or --user must be provided", {
            cause: new Error(
              'Usage: zero chat message send -t THREAD_ID --text "your message"\n       zero chat message send -u USER_ID -a AGENT_ID --text "your message"',
            ),
          });
        }
        if (thread && user) {
          throw new Error("--thread and --user are mutually exclusive", {
            cause: new Error(
              "Provide either --thread to send to an existing thread or --user to create a new thread, not both",
            ),
          });
        }

        // Validate --agent is required with --user
        if (user && !agent) {
          throw new Error("--agent is required when --user is provided", {
            cause: new Error(
              'Usage: zero chat message send -u USER_ID -a AGENT_ID --text "your message"',
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
          user: user || undefined,
          agent: agent || undefined,
          text,
        });

        console.log(
          chalk.green(
            `✓ Message sent (id: ${result.messageId}, thread: ${result.threadId})`,
          ),
        );
      },
    ),
  );
