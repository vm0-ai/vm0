import { Command } from "commander";
import { sendCommand } from "./send";

export const zeroSlackMessageCommand = new Command()
  .name("message")
  .description("Manage Slack messages")
  .addCommand(sendCommand);
