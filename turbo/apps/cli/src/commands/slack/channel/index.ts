import { Command } from "commander";
import { listCommand } from "./list";

export const slackChannelCommand = new Command()
  .name("channel")
  .description("Discover Slack channels and bot membership")
  .addCommand(listCommand);
