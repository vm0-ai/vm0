import { readFileSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import { sendSlackMessage } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";

export const sendCommand = new Command()
  .name("send")
  .description("Send a message to a Slack channel")
  .requiredOption("-c, --channel <id>", "Channel ID")
  .option("-t, --text <message>", "Message text")
  .option("--thread <ts>", "Thread timestamp for replies")
  .option("--blocks <json>", "Block Kit JSON string")
  .addHelpText(
    "after",
    `
Examples:
  Simple message:        zero slack message send -c C01234 -t "Hello!"
  Reply in thread:       zero slack message send -c C01234 --thread 1234567890.123456 -t "reply"
  Rich blocks:           zero slack message send -c C01234 --blocks '[{"type":"section","text":{"type":"mrkdwn","text":"*Bold*"}}]'

Notes:
  - Either --text or --blocks is required; both can be used together`,
  )
  .action(
    withErrorHandler(
      async (options: {
        channel: string;
        text?: string;
        thread?: string;
        blocks?: string;
      }) => {
        let text = options.text;
        const { channel, thread, blocks: blocksStr } = options;

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
          channel,
          text: text || undefined,
          threadTs: thread,
          blocks,
        });

        const tsInfo = result.ts ? ` (ts: ${result.ts})` : "";
        console.log(chalk.green(`✓ Message sent${tsInfo}`));
      },
    ),
  );
