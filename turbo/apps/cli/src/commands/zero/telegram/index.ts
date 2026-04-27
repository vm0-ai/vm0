import { Command } from "commander";
import { downloadFileCommand } from "./download-file";

export const zeroTelegramCommand = new Command()
  .name("telegram")
  .description("Download files from Telegram as the bot")
  .addCommand(downloadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Download a file:  zero telegram download-file <file-id> --bot-id <bot-id> -o /tmp/out.jpg`,
  );
