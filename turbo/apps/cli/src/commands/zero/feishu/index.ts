import { Command } from "commander";

import { zeroFeishuMessageCommand } from "./message";

export const zeroFeishuCommand = new Command()
  .name("feishu")
  .description("Send messages to Feishu as an organization bot")
  .addCommand(zeroFeishuMessageCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send to a chat:       zero feishu message send -c <chat-id> -t "Hello!"
  Send a DM:            zero feishu message send -u <open-id> -t "Hello!"
  Reply in a thread:    zero feishu message send -r <message-id> --thread -t "Reply"`,
  );
