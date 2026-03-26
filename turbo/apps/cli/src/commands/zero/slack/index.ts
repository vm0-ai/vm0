import { Command } from "commander";
import { zeroSlackMessageCommand } from "./message";

export const zeroSlackCommand = new Command()
  .name("slack")
  .description("Send messages to Slack channels as the bot")
  .addCommand(zeroSlackMessageCommand);
