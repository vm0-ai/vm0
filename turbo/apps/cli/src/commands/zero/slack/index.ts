import { Command } from "commander";
import { zeroSlackMessageCommand } from "./message";

export const zeroSlackCommand = new Command()
  .name("slack")
  .description("Send messages to Slack channels as the bot")
  .addCommand(zeroSlackMessageCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send a message:        zero slack message send -c <channel-id> -t "Hello!"
  Reply in a thread:     zero slack message send -c <channel-id> --thread <ts> -t "reply"`,
  );
