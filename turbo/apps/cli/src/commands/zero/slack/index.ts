import { Command } from "commander";
import { zeroSlackMessageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";
import { downloadFileCommand } from "./download-file";

export const zeroSlackCommand = new Command()
  .name("slack")
  .description(
    "Send messages, upload files, and download files from Slack as the bot",
  )
  .addCommand(zeroSlackMessageCommand)
  .addCommand(uploadFileCommand)
  .addCommand(downloadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send a message:        zero slack message send -c <channel-id> -t "Hello!"
  Reply in a thread:     zero slack message send -c <channel-id> --thread <ts> -t "reply"
  Upload a file:         zero slack upload-file -f /tmp/report.pdf -c <channel-id>
  Download a file:       zero slack download-file <file-id> -o /tmp/out.png`,
  );
