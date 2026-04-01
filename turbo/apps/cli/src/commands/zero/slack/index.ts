import { Command } from "commander";
import { zeroSlackMessageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";

export const zeroSlackCommand = new Command()
  .name("slack")
  .description("Send messages and upload files to Slack channels as the bot")
  .addCommand(zeroSlackMessageCommand)
  .addCommand(uploadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send a message:        zero slack message send -c <channel-id> -t "Hello!"
  Reply in a thread:     zero slack message send -c <channel-id> --thread <ts> -t "reply"
  Upload a file:         zero slack upload-file -f /tmp/report.pdf -c <channel-id>`,
  );
