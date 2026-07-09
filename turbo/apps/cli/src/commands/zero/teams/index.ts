import { Command } from "commander";
import { zeroTeamsMessageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";
import { downloadFileCommand } from "./download-file";

export const zeroTeamsCommand = new Command()
  .name("teams")
  .description(
    "Send messages, upload files, and download files from Microsoft Teams as the bot",
  )
  .addCommand(zeroTeamsMessageCommand)
  .addCommand(uploadFileCommand)
  .addCommand(downloadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send a message:    zero teams message send -c <conversation-id> -t "Hello!"
  DM a user:         zero teams message send -u me -t "Hello!"
  Reply in a thread: zero teams message send -c <conversation-id> --thread <activity-id> -t "reply"
  Upload a file:     zero teams upload-file -f /tmp/report.pdf -c <conversation-id>
  Download a file:   zero teams download-file <file-id> -o /tmp/out.png`,
  );
