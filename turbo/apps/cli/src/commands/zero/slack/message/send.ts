import { readFileSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import { sendSlackMessage } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";

export const sendCommand = new Command()
  .name("send")
  .description("Send a message to a Slack channel or DM a user")
  .option("-c, --channel <id>", "Channel ID")
  .option("-u, --user <id>", 'Slack user ID for DM (use "me" for yourself)')
  .option("-t, --text <message>", "Message text")
  .option("--thread <ts>", "Thread timestamp for replies")
  .option("--blocks <json>", "Block Kit JSON string")
  .addHelpText(
    "after",
    `
Examples:
  Simple message:        zero slack message send -c C01234 -t "Hello!"
  DM a user:             zero slack message send -u U0A8V9X98QJ -t "Hello!"
  DM yourself:           zero slack message send -u me -t "Hello!"
  Reply in thread:       zero slack message send -c C01234 --thread 1234567890.123456 -t "reply"
  Rich blocks:           zero slack message send -c C01234 --blocks '[{"type":"section","text":{"type":"mrkdwn","text":"*Bold*"}}]'

Notes:
  - Either --channel or --user is required; they are mutually exclusive
  - Either --text or --blocks is required; both can be used together`,
  )
  .action(
    withErrorHandler(
      async (options: {
        channel?: string;
        user?: string;
        text?: string;
        thread?: string;
        blocks?: string;
      }) => {
        let text = options.text;
        const { channel, user, thread, blocks: blocksStr } = options;

        // Validate mutual exclusion: exactly one of --channel or --user
        if (!channel && !user) {
          throw new Error("Either --channel or --user must be provided", {
            cause: new Error(
              'Usage: zero slack message send -c CHANNEL_ID -t "your message"\n       zero slack message send -u USER_ID -t "your message"',
            ),
          });
        }
        if (channel && user) {
          throw new Error("--channel and --user are mutually exclusive", {
            cause: new Error(
              "Provide either --channel to send to a channel or --user to DM a user, not both",
            ),
          });
        }

        // Read from stdin if text not provided and stdin is explicitly piped
        // (isTTY is false when piped, undefined when no TTY context e.g. tests)
        if (!text && process.stdin.isTTY === false) {
          text = readFileSync("/dev/stdin", "utf8").trim();
        }

        // Parse blocks JSON if provided
        let blocks: Array<{ type: string; [key: string]: unknown }> | undefined;
        if (blocksStr) {
          try {
            blocks = JSON.parse(blocksStr) as Array<{
              type: string;
              [key: string]: unknown;
            }>;
          } catch {
            throw new Error("Invalid JSON for --blocks flag", {
              cause: new Error(
                "Provide a valid JSON array of Block Kit blocks",
              ),
            });
          }
        }

        // Validate at least one of text or blocks
        if (!text && !blocks) {
          throw new Error("Either --text or --blocks must be provided", {
            cause: new Error(
              'Usage: zero slack message send -c CHANNEL_ID -t "your message"',
            ),
          });
        }

        const result = await sendSlackMessage({
          channel: channel || undefined,
          user: user || undefined,
          text: text || undefined,
          threadTs: thread,
          blocks,
        });

        const tsInfo = result.ts ? ` (ts: ${result.ts})` : "";
        console.log(chalk.green(`✓ Message sent${tsInfo}`));
      },
    ),
  );
