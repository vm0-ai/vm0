import { Command } from "commander";
import { downloadFileCommand } from "./download-file";
import { messageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";

export const zeroPhoneCommand = new Command()
  .name("phone")
  .description("Send AgentPhone messages, upload files, and download media")
  .addCommand(messageCommand)
  .addCommand(downloadFileCommand)
  .addCommand(uploadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send a message:   zero phone message --to +15551234567 -t "Hello!"
  Upload a file:    zero phone upload-file -f /tmp/report.pdf --to +15551234567
  Download a file:  zero phone download-file <file-id> -o /tmp/out.jpg`,
  );
