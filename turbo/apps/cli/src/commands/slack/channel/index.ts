import { Command } from "commander";
import { listCommand } from "./list";

export const slackChannelCommand = new Command()
  .name("channel")
  .description("Discover channels shared by your Slack account and Okou")
  .addCommand(listCommand);
