import { Command } from "commander";

import { sendCommand } from "./send";

export const feishuMessageCommand = new Command()
  .name("message")
  .description("Send Feishu messages")
  .addCommand(sendCommand);
