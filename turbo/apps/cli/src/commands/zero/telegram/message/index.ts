import { Command } from "commander";
import { sendCommand } from "./send";

export const zeroTelegramMessageCommand = new Command()
  .name("message")
  .description("Manage Telegram messages")
  .addCommand(sendCommand)
  .addHelpText(
    "after",
    `
Examples:
  zero telegram message send --bot-id <bot-id> -c <chat-id> -t "Hello!"`,
  );
