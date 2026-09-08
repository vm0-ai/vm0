import { Command } from "commander";
import { sendCommand } from "./send";
import { historyCommand } from "./history";

export const slackMessageCommand = new Command()
  .name("message")
  .description("Manage Slack messages")
  .addCommand(sendCommand)
  .addCommand(historyCommand)
  .addHelpText(
    "after",
    `
Examples:
  okou slack message send -c <channel-id> -t "Hello!"
  okou slack message history -c <channel-or-dm-id> --json`,
  );
