import { readFileSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import { sendTeamsMessage } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";

export const sendCommand = new Command()
  .name("send")
  .description("Send a message to a Microsoft Teams conversation as the bot")
  .requiredOption("-c, --conversation-id <id>", "Teams conversation ID")
  .option("-t, --text <message>", "Message text")
  .option("--activity-id <id>", "Activity ID to reply to")
  .addHelpText(
    "after",
    `
Examples:
  Simple message: zero teams message send -c 19:thread@thread.tacv2 -t "Hello!"
  Thread reply:   zero teams message send -c 19:thread@thread.tacv2 --activity-id root-activity -t "reply"

Notes:
  - Message text can be provided with --text or piped on stdin
  - Use the Conversation ID and Activity ID from the current Teams run prompt`,
  )
  .action(
    withErrorHandler(
      async (options: {
        conversationId: string;
        text?: string;
        activityId?: string;
      }) => {
        let text = options.text;
        if (!text && !process.stdin.isTTY) {
          try {
            text = readFileSync("/dev/stdin", "utf8").trim();
          } catch {
            // stdin not readable; fall through to the missing-text validation.
          }
        }

        if (!text) {
          throw new Error("Either --text or piped stdin must be provided", {
            cause: new Error(
              'Usage: zero teams message send -c CONVERSATION_ID -t "your message"',
            ),
          });
        }

        const result = await sendTeamsMessage({
          conversationId: options.conversationId,
          activityId: options.activityId,
          text,
        });

        const activityInfo = result.activityId
          ? ` (activity_id: ${result.activityId})`
          : "";
        console.log(chalk.green(`✓ Message sent${activityInfo}`));
      },
    ),
  );
