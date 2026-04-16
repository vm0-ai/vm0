import { Command } from "commander";
import { sendCommand } from "./send";

export const zeroChatMessageCommand = new Command()
  .name("message")
  .description("Manage chat messages")
  .addCommand(sendCommand)
  .addHelpText(
    "after",
    `
Examples:
  zero chat message send -t <thread-id> --text "Hello!"`,
  );
