import { Command } from "commander";
import { zeroTelegramBotCommand } from "./bot";
import { downloadFileCommand } from "./download-file";
import { zeroTelegramMessageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";

export const zeroTelegramCommand = new Command()
  .name("telegram")
  .description(
    "Inspect bots, send messages, upload files, and download files from Telegram",
  )
  .addCommand(zeroTelegramBotCommand)
  .addCommand(zeroTelegramMessageCommand)
  .addCommand(downloadFileCommand)
  .addCommand(uploadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  List bots:        okou telegram bot list
  Send a message:   okou telegram message send --bot-id <bot-id> -c <chat-id> -t "Hello!"
  Upload a file:    okou telegram upload-file -f /tmp/report.pdf --bot-id <bot-id> -c <chat-id>
  Download a file:  okou telegram download-file <file-id> --bot-id <bot-id> -o /tmp/out.jpg`,
  );
