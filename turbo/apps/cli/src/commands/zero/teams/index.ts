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
  Send a message:    okou teams message send -c <conversation-id> -t "Hello!"
  DM a user:         okou teams message send -u me -t "Hello!"
  Reply in a thread: okou teams message send -c <conversation-id> --thread <activity-id> -t "reply"
  Upload a file:     okou teams upload-file -f /tmp/report.pdf -c <conversation-id>
  Download a file:   okou teams download-file <file-id> -o /tmp/out.png`,
  );
