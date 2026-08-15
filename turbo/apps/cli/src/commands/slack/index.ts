import { Command } from "commander";
import { slackMessageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";
import { downloadFileCommand } from "./download-file";

export const slackCommand = new Command()
  .name("slack")
  .description(
    "Send messages, upload files, and download files from Slack as the bot",
  )
  .addCommand(slackMessageCommand)
  .addCommand(uploadFileCommand)
  .addCommand(downloadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send a message:        okou slack message send -c <channel-id> -t "Hello!"
  Reply in a thread:     okou slack message send -c <channel-id> --thread <ts> -t "reply"
  Upload a file:         okou slack upload-file -f /tmp/report.pdf -c <channel-id>
  Download a file:       okou slack download-file <file-id> -o /tmp/out.png`,
  );
