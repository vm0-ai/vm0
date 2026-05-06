import { readFileSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import { sendTelegramMessage } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export const sendCommand = new Command()
  .name("send")
  .description("Send a message to a Telegram chat as the bot")
  .requiredOption("--bot-id <id>", "Telegram bot ID")
  .requiredOption("-c, --chat-id <id>", "Telegram chat ID")
  .option("-t, --text <message>", "Message text")
  .option("--reply-to-message-id <id>", "Message ID to reply to")
  .option("--message-thread-id <id>", "Telegram forum topic thread ID")
  .addHelpText(
    "after",
    `
Examples:
  Simple message:      zero telegram message send --bot-id 123456789 -c -1001234567890 -t "Hello!"
  Reply to message:    zero telegram message send --bot-id 123456789 -c -1001234567890 --reply-to-message-id 42 -t "reply"
  Forum topic message: zero telegram message send --bot-id 123456789 -c -1001234567890 --message-thread-id 7 -t "topic update"

Notes:
  - Message text can be provided with --text or piped on stdin
  - Choose an explicit --bot-id. Run "zero telegram bot list" to inspect available bots.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        botId: string;
        chatId: string;
        text?: string;
        replyToMessageId?: string;
        messageThreadId?: string;
      }) => {
        let text = options.text;
        if (!text && process.stdin.isTTY === false) {
          text = readFileSync("/dev/stdin", "utf8").trim();
        }

        if (!text) {
          throw new Error("Either --text or piped stdin must be provided", {
            cause: new Error(
              'Usage: zero telegram message send --bot-id BOT_ID -c CHAT_ID -t "your message"',
            ),
          });
        }

        const result = await sendTelegramMessage({
          botId: options.botId,
          chatId: options.chatId,
          text,
          replyToMessageId: options.replyToMessageId
            ? parsePositiveInteger(
                options.replyToMessageId,
                "reply-to-message-id",
              )
            : undefined,
          messageThreadId: options.messageThreadId
            ? parsePositiveInteger(options.messageThreadId, "message-thread-id")
            : undefined,
        });

        console.log(
          chalk.green(`✓ Message sent (message_id: ${result.messageId})`),
        );
      },
    ),
  );
