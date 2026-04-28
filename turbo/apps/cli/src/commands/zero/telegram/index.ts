import { Command } from "commander";
import { downloadFileCommand } from "./download-file";
import { zeroTelegramMessageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";

export const zeroTelegramCommand = new Command()
  .name("telegram")
  .description(
    "Send messages, upload files, and download files from Telegram as the bot",
  )
  .addCommand(zeroTelegramMessageCommand)
  .addCommand(downloadFileCommand)
  .addCommand(uploadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send a message:   zero telegram message send --bot-id <bot-id> -c <chat-id> -t "Hello!"
  Upload a file:    zero telegram upload-file -f /tmp/report.pdf --bot-id <bot-id> -c <chat-id>
  Download a file:  zero telegram download-file <file-id> --bot-id <bot-id> -o /tmp/out.jpg`,
  );
