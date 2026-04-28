import { Command } from "commander";
import { listCommand } from "./list";

export const zeroTelegramBotCommand = new Command()
  .name("bot")
  .description("Inspect Telegram bots")
  .addCommand(listCommand)
  .addHelpText(
    "after",
    `
Examples:
  zero telegram bot list`,
  );
