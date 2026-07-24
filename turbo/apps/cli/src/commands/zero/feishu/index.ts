import { Command } from "commander";

import { downloadFileCommand } from "./download-file";
import { zeroFeishuMessageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";

export const zeroFeishuCommand = new Command()
  .name("feishu")
  .description("Send messages and transfer files through Feishu")
  .addCommand(zeroFeishuMessageCommand)
  .addCommand(downloadFileCommand)
  .addCommand(uploadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send to a chat:       zero feishu message send -c <chat-id> -t "Hello!"
  Send a DM:            zero feishu message send -u <open-id> -t "Hello!"
  Reply in a thread:    zero feishu message send -r <message-id> --thread -t "Reply"
  Upload a file:        zero feishu upload-file -f /tmp/report.pdf -c <chat-id>
  Download a file:      zero feishu download-file <message-id> <file-key> --type file`,
  );
