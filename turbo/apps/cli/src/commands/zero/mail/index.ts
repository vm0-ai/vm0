import { Command } from "commander";

import { connectCommand } from "./connect";
import { listCommand } from "./list";
import { sendCommand } from "./send";

export const zeroMailCommand = new Command()
  .name("mail")
  .description("Review and send mail through Gmail or Outlook Mail")
  .addCommand(listCommand)
  .addCommand(connectCommand)
  .addCommand(sendCommand);
