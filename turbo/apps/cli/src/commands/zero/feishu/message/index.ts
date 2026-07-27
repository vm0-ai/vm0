import { Command } from "commander";

import { sendCommand } from "./send";

export const zeroFeishuMessageCommand = new Command()
  .name("message")
  .description("Send Feishu messages")
  .addCommand(sendCommand);
