import { Command } from "commander";
import { sendCommand } from "./send";

export const slackMessageCommand = new Command()
  .name("message")
  .description("Manage Slack messages")
  .addCommand(sendCommand)
  .addHelpText(
    "after",
    `
Examples:
  okou slack message send -c <channel-id> -t "Hello!"`,
  );
