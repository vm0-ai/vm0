import { Command } from "commander";
import { sendCommand } from "./send";

export const zeroTeamsMessageCommand = new Command()
  .name("message")
  .description("Manage Microsoft Teams messages")
  .addCommand(sendCommand)
  .addHelpText(
    "after",
    `
Examples:
  okou teams message send -c <conversation-id> -t "Hello!"
  okou teams message send -u me -t "Hello!"`,
  );
