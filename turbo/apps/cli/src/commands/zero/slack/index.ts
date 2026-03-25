import { Command } from "commander";
import { zeroSlackMessageCommand } from "./message";

export const zeroSlackCommand = new Command()
  .name("slack")
  .description("Manage Slack integrations")
  .addCommand(zeroSlackMessageCommand);
