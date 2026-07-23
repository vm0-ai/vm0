import { readFileSync } from "node:fs";

import chalk from "chalk";
import { Command } from "commander";

import { sendFeishuMessage } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";

interface SendFeishuOptions {
  readonly installation?: string;
  readonly chat?: string;
  readonly user?: string;
  readonly reply?: string;
  readonly thread?: boolean;
  readonly text?: string;
  readonly card?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCard(
  input: string | undefined,
): Record<string, unknown> | undefined {
  if (!input) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Invalid JSON for --card flag", {
      cause: new Error("Provide a valid Feishu card JSON object"),
    });
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid JSON for --card", {
      cause: new Error("Provide a Feishu card JSON object"),
    });
  }
  return parsed;
}

export const sendCommand = new Command()
  .name("send")
  .description("Send a message to a Feishu chat or user")
  .option("-i, --installation <id>", "Feishu installation ID")
  .option("-c, --chat <id>", "Feishu chat ID")
  .option("-u, --user <open-id>", 'Feishu user open ID (use "me" for yourself)')
  .option("-r, --reply <message-id>", "Message ID to reply to")
  .option("--thread", "Reply in a Feishu thread")
  .option("-t, --text <message>", "Message text")
  .option("--card <json>", "Feishu interactive card JSON")
  .addHelpText(
    "after",
    `
Examples:
  Chat message:          zero feishu message send -c oc_xxx -t "Hello!"
  Direct message:        zero feishu message send -u ou_xxx -t "Hello!"
  DM yourself:           zero feishu message send -u me -t "Hello!"
  Thread reply:          zero feishu message send -r om_xxx --thread -t "Reply"
  Interactive card:      zero feishu message send -c oc_xxx --card '{"schema":"2.0","body":{"elements":[]}}'
  Select a custom app:   zero feishu message send -i <installation-id> -c oc_xxx -t "Hello!"

Notes:
  - Exactly one of --chat, --user, or --reply is required
  - Exactly one of --text or --card is required
  - --installation is required when the organization has multiple Feishu bots`,
  )
  .action(
    withErrorHandler(async (options: SendFeishuOptions) => {
      const targets = [options.chat, options.user, options.reply].filter(
        Boolean,
      );
      if (targets.length !== 1) {
        throw new Error(
          "Exactly one of --chat, --user, or --reply must be provided",
        );
      }
      if (options.thread && !options.reply) {
        throw new Error("--thread requires --reply");
      }

      let text = options.text;
      if (!text && !options.card && !process.stdin.isTTY) {
        try {
          text = readFileSync("/dev/stdin", "utf8").trim();
        } catch {
          // stdin is not readable; fall through to normal input validation.
        }
      }
      const card = parseCard(options.card);
      if (Boolean(text) === Boolean(card)) {
        throw new Error("Exactly one of --text or --card must be provided");
      }

      const result = await sendFeishuMessage({
        installationId: options.installation,
        chat: options.chat,
        user: options.user,
        replyToMessageId: options.reply,
        replyInThread: options.thread,
        text,
        card,
      });
      console.log(chalk.green(`✓ Message sent (message: ${result.messageId})`));
    }),
  );
